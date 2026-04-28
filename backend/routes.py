"""
Flask REST API routes for the EMG Gesture Classifier.
"""

import os
import json
import random
from datetime import datetime, timezone

from flask import Blueprint, request, jsonify
from werkzeug.security import generate_password_hash, check_password_hash

from config import (
    BASE_DIR, MODELS_DIR, GESTURE_CLASSES,
    UNLOCK_ORDER, AUTO_UNLOCK_ACCURACY, AUTO_UNLOCK_MIN_TESTS,
    T_ON, T_OFF, MIN_VOTES, GESTURE_S, REST_S, REPS_PER_GESTURE,
    TRAINING_DIR,
)
import state
from models import db, User, Gesture, UserGesture, Session, TestingTrial, TrainingGesture, TrainingFile, ModelVersion

# Will be set by app.py after socketio is created
_socketio = None

def set_socketio(sio):
    global _socketio
    _socketio = sio

api = Blueprint("api", __name__)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _check_auto_unlock(user_id):
    """Unlock the next gesture if all currently-unlocked gestures meet thresholds."""
    ugs = UserGesture.query.filter_by(user_id=user_id).all()
    ug_by_name = {}
    for ug in ugs:
        g = db.session.get(Gesture, ug.gesture_id)
        if g:
            ug_by_name[g.gesture_name] = ug

    unlocked = [ug_by_name[n] for n in UNLOCK_ORDER if n in ug_by_name and ug_by_name[n].is_unlocked]
    if not unlocked:
        return None

    for ug in unlocked:
        total = ug.total_times_tested
        if total < AUTO_UNLOCK_MIN_TESTS:
            return None
        accuracy = round(ug.correct_predictions / total * 100, 1) if total > 0 else 0.0
        if accuracy < AUTO_UNLOCK_ACCURACY:
            return None

    for name in UNLOCK_ORDER:
        ug = ug_by_name.get(name)
        if ug and not ug.is_unlocked:
            ug.is_unlocked = True
            db.session.commit()
            return name
    return None


def _session_display_name(session):
    if getattr(session, "session_name", None):
        return session.session_name
    started = session.started_at.isoformat() if session.started_at else None
    if started:
        return f"Practice Session {session.id}"
    return f"Session {session.id}"


def _serialize_progress_session(session):
    trials = sorted(session.testing_trials, key=lambda trial: (trial.display_order or 0, trial.id))
    correct = sum(1 for trial in trials if trial.was_correct)
    skipped = sum(1 for trial in trials if trial.was_skipped)
    incorrect = sum(1 for trial in trials if not trial.was_correct)
    scored = correct + incorrect
    overall_accuracy = round((correct / scored) * 100, 1) if scored else 0.0

    gesture_buckets = {}
    for trial in trials:
        gesture_name = trial.ground_truth or (trial.gesture.gesture_name if trial.gesture else "Unknown")
        bucket = gesture_buckets.setdefault(gesture_name, {
            "name": gesture_name,
            "correct": 0,
            "incorrect": 0,
            "skipped": 0,
        })
        if trial.was_correct:
            bucket["correct"] += 1
        elif trial.was_skipped:
            bucket["incorrect"] += 1
            bucket["skipped"] += 1
        else:
            bucket["incorrect"] += 1

    gestures = []
    for bucket in gesture_buckets.values():
        total = bucket["correct"] + bucket["incorrect"]
        gestures.append({
            **bucket,
            "accuracy": round((bucket["correct"] / total) * 100, 1) if total else 0.0,
        })

    gestures.sort(key=lambda gesture: (gesture["accuracy"], gesture["name"]))

    return {
      "id": session.id,
      "name": _session_display_name(session),
      "startedAt": session.started_at.isoformat() if session.started_at else None,
      "actualDuration": session.actual_duration,
      "totalScored": len(trials),
      "overallAccuracy": overall_accuracy,
      "correct": correct,
      "incorrect": incorrect,
      "skipped": skipped,
      "gestures": gestures,
    }


def _build_progress_payload(user_id):
    user = db.session.get(User, user_id)
    if not user:
        return None

    gesture_stats = []
    for ug in user.user_gestures:
        gesture = db.session.get(Gesture, ug.gesture_id)
        effective_accuracy = round((ug.correct_predictions / ug.total_times_tested) * 100, 1) if ug.total_times_tested > 0 else 0.0
        effective_incorrect = max(0, ug.total_times_tested - ug.correct_predictions)
        misclassified = (
            db.session.query(TestingTrial.prediction, db.func.count(TestingTrial.id).label("count"))
            .filter(
                TestingTrial.user_id == user_id,
                TestingTrial.gesture_id == ug.gesture_id,
                TestingTrial.was_correct.is_(False),
                TestingTrial.was_skipped.is_(False),
                TestingTrial.prediction.isnot(None),
            )
            .group_by(TestingTrial.prediction)
            .order_by(db.func.count(TestingTrial.id).desc(), TestingTrial.prediction.asc())
            .first()
        )
        gesture_stats.append({
            "gestureId": gesture.id,
            "name": gesture.gesture_name,
            "image": gesture.gesture_image,
            "accuracy": effective_accuracy,
            "totalTrained": ug.total_times_trained,
            "totalTested": ug.total_times_tested,
            "correct": ug.correct_predictions,
            "incorrect": effective_incorrect,
            "avgConfidence": round(ug.average_confidence, 1),
            "needsRetraining": ug.needs_retraining,
            "isUnlocked": ug.is_unlocked,
            "isEnabled": ug.is_enabled,
            "mostMisclassifiedAs": misclassified[0] if misclassified else None,
        })

    visible_gestures = [gesture for gesture in gesture_stats if gesture["isUnlocked"]]
    avg_gesture_accuracy = round(
        sum(gesture["accuracy"] for gesture in visible_gestures) / len(visible_gestures), 1
    ) if visible_gestures else 0.0

    sessions = (
        Session.query
        .filter_by(user_id=user_id, session_type="testing")
        .order_by(Session.started_at.desc(), Session.id.desc())
        .all()
    )
    session_payloads = [_serialize_progress_session(session) for session in sessions]

    return {
        "averageGestureAccuracy": avg_gesture_accuracy,
        "totalSessions": len(session_payloads),
        "gestures": gesture_stats,
        "sessions": session_payloads,
    }


# ── Index ─────────────────────────────────────────────────────────────────────

@api.route("/")
def index():
    return {"status": "EMG Gesture Classifier backend running"}


# ── Auth ──────────────────────────────────────────────────────────────────────

@api.route("/api/register", methods=["POST"])
def register():
    data = request.get_json(silent=True) or {}
    first_name = (data.get("firstName") or "").strip()
    last_name  = (data.get("lastName")  or "").strip()
    username   = (data.get("username")  or "").strip().lower()
    password   = data.get("password") or ""
    if not all([first_name, last_name, username, password]):
        return jsonify({"error": "All fields are required"}), 400
    if User.query.filter(User.username.ilike(username)).first():
        return jsonify({"error": "Username already taken"}), 409
    user = User(
        first_name=first_name, last_name=last_name, username=username,
        password_hash=generate_password_hash(password),
        last_login=datetime.now(timezone.utc),
    )
    db.session.add(user)
    db.session.commit()
    default_unlocked = {"Open", "Close"}
    for g in Gesture.query.all():
        db.session.add(UserGesture(
            user_id=user.id, gesture_id=g.id,
            is_unlocked=(g.gesture_name in default_unlocked),
        ))
    db.session.commit()
    return jsonify({
        "id": user.id, "username": user.username,
        "firstName": user.first_name, "lastName": user.last_name,
        "isAdmin": user.is_admin,
    }), 201


@api.route("/api/login", methods=["POST"])
def login():
    data     = request.get_json(silent=True) or {}
    username = (data.get("username") or "").strip().lower()
    password = data.get("password") or ""
    if not username or not password:
        return jsonify({"error": "Username and password are required"}), 400
    user = User.query.filter(User.username.ilike(username)).first()
    if not user or not check_password_hash(user.password_hash, password):
        return jsonify({"error": "Invalid username or password"}), 401
    user.last_login = datetime.now(timezone.utc)
    # restore saved thresholds into runtime config
    if user.pref_t_on is not None:
        state.runtime_config["t_on"] = user.pref_t_on
    if user.pref_t_off is not None:
        state.runtime_config["t_off"] = user.pref_t_off
    if user.pref_min_votes is not None:
        state.runtime_config["min_votes"] = user.pref_min_votes
    db.session.commit()
    return jsonify({
        "id": user.id, "username": user.username,
        "firstName": user.first_name, "lastName": user.last_name,
        "isAdmin": user.is_admin,
    })


# ── Dashboard ─────────────────────────────────────────────────────────────────

@api.route("/api/dashboard/<int:user_id>")
def dashboard(user_id):
    user = db.session.get(User, user_id)
    if not user:
        return jsonify({"error": "User not found"}), 404
    gesture_stats = []
    for ug in user.user_gestures:
        g = db.session.get(Gesture, ug.gesture_id)
        gesture_stats.append({
            "gestureId": g.id, "name": g.gesture_name, "image": g.gesture_image,
            "accuracy": round((ug.correct_predictions / ug.total_times_tested) * 100, 1) if ug.total_times_tested > 0 else 0.0, "totalTrained": ug.total_times_trained,
            "totalTested": ug.total_times_tested, "correct": ug.correct_predictions,
            "incorrect": max(0, ug.total_times_tested - ug.correct_predictions), "avgConfidence": round(ug.average_confidence, 1),
            "needsRetraining": ug.needs_retraining, "isUnlocked": ug.is_unlocked,
            "isEnabled": ug.is_enabled,
        })
    unlocked        = [g for g in gesture_stats if g["isUnlocked"]]
    total_correct   = sum(g["correct"]   for g in unlocked)
    total_incorrect = sum(g["incorrect"] for g in unlocked)
    total_preds     = total_correct + total_incorrect
    overall_acc     = round(total_correct / total_preds * 100, 1) if total_preds > 0 else 0.0
    gestures_trained = sum(1 for g in unlocked if g["totalTrained"] > 0)
    recent = Session.query.filter_by(user_id=user_id).order_by(Session.started_at.desc()).limit(5).all()
    recent_sessions = [{
        "id": s.id, "type": s.session_type, "status": s.status,
        "startedAt": s.started_at.isoformat() if s.started_at else None,
        "duration": s.actual_duration,
    } for s in recent]
    suggestions = []
    weak = [g for g in unlocked if g["totalTested"] >= 5 and g["accuracy"] < 60]
    if weak:
        worst = min(weak, key=lambda g: g["accuracy"])
        suggestions.append(f"{worst['name']} has {worst['accuracy']}% accuracy — consider retraining it.")
    untrained = [g for g in unlocked if g["totalTrained"] == 0]
    if untrained:
        suggestions.append(f"You have {len(untrained)} unlocked gesture(s) that haven't been trained yet.")
    if user.training_streak == 0:
        suggestions.append("Start a training session to begin your streak!")
    elif user.training_streak >= 3:
        suggestions.append(f"Nice {user.training_streak}-day streak! Keep it up.")
    return jsonify({
        "streak": user.training_streak, "overallAccuracy": overall_acc,
        "gesturesTrained": gestures_trained, "totalGestures": len(gesture_stats),
        "gestures": gesture_stats, "recentSessions": recent_sessions,
        "suggestions": suggestions,
    })


@api.route("/api/progress/<int:user_id>")
def progress(user_id):
    payload = _build_progress_payload(user_id)
    if payload is None:
        return jsonify({"error": "User not found"}), 404
    return jsonify(payload)


@api.route("/api/progress/sessions/<int:session_id>", methods=["PATCH"])
def rename_progress_session(session_id):
    data = request.get_json(silent=True) or {}
    user_id = data.get("userId")
    session_name = (data.get("sessionName") or "").strip()
    if not user_id:
        return jsonify({"error": "userId required"}), 400
    if not session_name:
        return jsonify({"error": "sessionName required"}), 400

    session = Session.query.filter_by(id=session_id, user_id=user_id, session_type="testing").first()
    if not session:
        return jsonify({"error": "Session not found"}), 404

    session.session_name = session_name
    db.session.commit()
    return jsonify({"ok": True, "sessionId": session.id, "sessionName": session.session_name})


@api.route("/api/progress/sessions/<int:session_id>", methods=["DELETE"])
def delete_progress_session(session_id):
    user_id = request.args.get("userId", type=int)
    if not user_id:
        return jsonify({"error": "userId required"}), 400

    session = Session.query.filter_by(id=session_id, user_id=user_id, session_type="testing").first()
    if not session:
        return jsonify({"error": "Session not found"}), 404

    db.session.delete(session)
    db.session.commit()
    return jsonify({"ok": True, "sessionId": session_id})


# ── Training ──────────────────────────────────────────────────────────────────

@api.route("/api/training/gestures/<int:user_id>")
def training_gestures(user_id):
    user = db.session.get(User, user_id)
    if not user:
        return jsonify({"error": "User not found"}), 404
    result = []
    for ug in user.user_gestures:
        if not ug.is_unlocked or not ug.is_enabled:
            continue
        g = db.session.get(Gesture, ug.gesture_id)
        result.append({
            "gestureId": g.id, "name": g.gesture_name, "image": g.gesture_image,
            "totalTrained": ug.total_times_trained, "needsRetraining": ug.needs_retraining,
        })
    return jsonify({"gestures": result})


# ── Testing ───────────────────────────────────────────────────────────────────

@api.route("/api/testing/gestures/<int:user_id>")
def testing_gestures(user_id):
    user = db.session.get(User, user_id)
    if not user:
        return jsonify({"error": "User not found"}), 404
    result = []
    for ug in user.user_gestures:
        if not ug.is_unlocked or not ug.is_enabled:
            continue
        g = db.session.get(Gesture, ug.gesture_id)
        eligible = ug.total_times_trained >= 0
        accuracy = round((ug.correct_predictions / ug.total_times_tested) * 100, 1) if ug.total_times_tested > 0 else 0.0
        result.append({
            "gestureId": g.id, "name": g.gesture_name, "image": g.gesture_image,
            "accuracy": accuracy, "totalTrained": ug.total_times_trained,
            "totalTested": ug.total_times_tested, "eligible": eligible,
            "weight": max(1, 100 - int(accuracy)) if eligible else 0,
        })
    return jsonify({"gestures": result})


@api.route("/api/testing/sequence/<int:user_id>", methods=["POST"])
def testing_sequence(user_id):
    data  = request.get_json(silent=True) or {}
    count = int(data.get("count", 15))
    user  = db.session.get(User, user_id)
    if not user:
        return jsonify({"error": "User not found"}), 404
    eligible = []
    weights  = []
    for ug in user.user_gestures:
        if not ug.is_unlocked or not ug.is_enabled or ug.total_times_trained < 15:
            continue
        g = db.session.get(Gesture, ug.gesture_id)
        accuracy = round((ug.correct_predictions / ug.total_times_tested) * 100, 1) if ug.total_times_tested > 0 else 0.0
        eligible.append({"gestureId": g.id, "name": g.gesture_name, "image": g.gesture_image})
        weights.append(max(1, 100 - int(accuracy)))
    if not eligible:
        return jsonify({"error": "No eligible gestures (need ≥15 training reps each)"}), 400
    return jsonify({"sequence": random.choices(eligible, weights=weights, k=count)})


@api.route("/api/testing/session", methods=["POST"])
def create_test_session():
    data    = request.get_json(silent=True) or {}
    user_id = data.get("userId")
    if not user_id:
        return jsonify({"error": "userId required"}), 400
    sess = Session(
        user_id=user_id, session_type="testing",
        planned_duration=data.get("plannedDuration"),
        status="in_progress", started_at=datetime.now(timezone.utc),
        number_of_connected_channels=data.get("channels", 64),
    )
    db.session.add(sess)
    db.session.commit()

    state.test_sample_buffer     = []
    state.test_gesture_intervals = []
    state.test_session_user_id   = user_id
    state.test_session_id        = sess.id
    state.test_sample_counter    = 0

    return jsonify({"sessionId": sess.id})


@api.route("/api/testing/trial", methods=["POST"])
def record_test_trial():
    data         = request.get_json(silent=True) or {}
    user_id      = data.get("userId")
    session_id   = data.get("sessionId")
    gesture_id   = data.get("gestureId")
    prediction   = data.get("prediction")
    confidence   = data.get("confidence")
    ground_truth = data.get("groundTruth")
    was_correct  = data.get("wasCorrect")
    was_skipped  = data.get("wasSkipped", False)
    retry_count  = data.get("retryCount", 0)
    trial_number = data.get("trialNumber", 1)

    if state.test_session_id is not None and state.test_gesture_intervals:
        for iv in reversed(state.test_gesture_intervals):
            if iv[2] is None:
                if was_correct and not was_skipped and ground_truth:
                    iv[2] = ground_truth
                else:
                    iv[2] = False
                break

    display_order = TestingTrial.query.filter_by(session_id=session_id).count() + 1

    trial = TestingTrial(
        user_id=user_id, session_id=session_id, gesture_id=gesture_id,
        display_order=display_order, trial_number=trial_number,
        ground_truth=ground_truth, prediction=prediction, confidence=confidence,
        retry_count=retry_count, was_correct=was_correct, was_skipped=was_skipped,
    )
    db.session.add(trial)

    ug = UserGesture.query.filter_by(user_id=user_id, gesture_id=gesture_id).first()
    if ug:
        ug.total_times_tested += 1
        if was_correct:
            ug.correct_predictions += 1
        else:
            ug.incorrect_predictions += 1
        total = ug.total_times_tested
        ug.accuracy = round(ug.correct_predictions / total * 100, 1) if total > 0 else 0.0
        if confidence is not None:
            n = ug.total_times_tested
            ug.average_confidence = round(((ug.average_confidence * (n - 1)) + confidence) / n, 3)
        if ug.accuracy < 50 and total >= 5:
            ug.needs_retraining = True

    db.session.commit()

    newly_unlocked = _check_auto_unlock(user_id) if user_id else None

    return jsonify({
        "trialId": trial.id,
        "accuracy": ug.accuracy if ug else None,
        "newlyUnlocked": newly_unlocked,
    })


@api.route("/api/testing/session/<int:session_id>/end", methods=["POST"])
def end_test_session(session_id):
    data = request.get_json(silent=True) or {}
    sess = db.session.get(Session, session_id)
    if not sess:
        return jsonify({"error": "Session not found"}), 404
    sess.status   = data.get("status", "completed")
    sess.ended_at = datetime.now(timezone.utc)
    if sess.started_at:
        sa = sess.started_at if sess.started_at.tzinfo else sess.started_at.replace(tzinfo=timezone.utc)
        sess.actual_duration = (sess.ended_at - sa).total_seconds()
    db.session.commit()
    return jsonify({"ok": True})


# ── Models ────────────────────────────────────────────────────────────────────

@api.route("/api/models/list")
def list_models():
    user_id = request.args.get("userId", type=int)
    if user_id:
        models = ModelVersion.query.filter_by(user_id=user_id).order_by(ModelVersion.version_number.desc()).all()
        return jsonify([{
            "id": m.id,
            "name": m.name or f"Model v{m.version_number}",
            "filePath": m.file_path,
            "accuracy": m.accuracy,
            "isActive": m.is_active,
        } for m in models])
    if not os.path.isdir(MODELS_DIR):
        return jsonify([])
    files = sorted([f for f in os.listdir(MODELS_DIR) if f.endswith(".pkl")])
    return jsonify([{"name": f, "filePath": f"models/{f}", "accuracy": None, "isActive": False} for f in files])


# ── Admin ─────────────────────────────────────────────────────────────────────

@api.route("/api/admin/users")
def admin_users():
    users = User.query.filter_by(is_admin=False).order_by(User.first_name, User.last_name).all()
    return jsonify([{
        "id": u.id, "firstName": u.first_name,
        "lastName": u.last_name, "username": u.username,
    } for u in users])


@api.route("/api/admin/gestures/<int:user_id>")
def admin_gestures(user_id):
    user = db.session.get(User, user_id)
    if not user:
        return jsonify({"error": "User not found"}), 404
    result = []
    for ug in user.user_gestures:
        g = db.session.get(Gesture, ug.gesture_id)
        result.append({
            "gestureId": g.id, "name": g.gesture_name,
            "isUnlocked": ug.is_unlocked, "isEnabled": ug.is_enabled,
            "accuracy": round((ug.correct_predictions / ug.total_times_tested) * 100, 1) if ug.total_times_tested > 0 else 0.0,
            "avgConfidence": round(ug.average_confidence * 100, 1) if ug.average_confidence else 0,
            "totalTrained": ug.total_times_trained,
            "totalTested": ug.total_times_tested,
        })
    return jsonify(result)


@api.route("/api/admin/gestures/<int:user_id>/unlock", methods=["POST"])
def admin_toggle_unlock(user_id):
    data = request.get_json(silent=True) or {}
    gesture_id = data.get("gestureId")
    unlock = data.get("unlock", True)
    if gesture_id is None:
        return jsonify({"error": "gestureId required"}), 400
    ug = UserGesture.query.filter_by(user_id=user_id, gesture_id=gesture_id).first()
    if not ug:
        return jsonify({"error": "UserGesture not found"}), 404
    ug.is_unlocked = bool(unlock)
    db.session.commit()
    return jsonify({"ok": True, "gestureId": gesture_id, "isUnlocked": ug.is_unlocked})


@api.route("/api/admin/training-files/<int:user_id>")
def admin_training_files(user_id):
    files = TrainingFile.query.filter_by(user_id=user_id).order_by(TrainingFile.created_at.desc()).all()
    return jsonify([{
        "id": f.id, "fileName": f.file_name, "numSamples": f.num_samples,
        "gestures": json.loads(f.gestures) if f.gestures else [],
        "createdAt": f.created_at.isoformat() if f.created_at else None,
        "sessionId": f.session_id,
    } for f in files])


@api.route("/api/admin/models/<int:user_id>")
def admin_models(user_id):
    models = ModelVersion.query.filter_by(user_id=user_id).order_by(ModelVersion.version_number.desc()).all()
    result = []
    for m in models:
        file_ids = json.loads(m.training_file_ids) if m.training_file_ids else []
        file_names = []
        if file_ids:
            tfs = TrainingFile.query.filter(TrainingFile.id.in_(file_ids)).all()
            file_names = [tf.file_name for tf in tfs]
        result.append({
            "id": m.id, "versionNumber": m.version_number,
            "name": m.name,
            "accuracy": m.accuracy, "filePath": m.file_path,
            "trainingDate": m.training_date.isoformat() if m.training_date else None,
            "isActive": m.is_active,
            "trainingFiles": file_names,
        })
    return jsonify(result)


@api.route("/api/admin/models/<int:user_id>/set-active", methods=["POST"])
def admin_set_active_model(user_id):
    data = request.get_json(silent=True) or {}
    model_id = data.get("modelId")
    if not model_id:
        return jsonify({"error": "modelId required"}), 400
    ModelVersion.query.filter_by(user_id=user_id).update({"is_active": False})
    mv = ModelVersion.query.filter_by(id=model_id, user_id=user_id).first()
    if not mv:
        return jsonify({"error": "Model not found"}), 404
    mv.is_active = True
    db.session.commit()
    return jsonify({"ok": True, "activeModelId": mv.id})


@api.route("/api/admin/models/<int:model_id>", methods=["DELETE"])
def admin_delete_model(model_id):
    mv = ModelVersion.query.get(model_id)
    if not mv:
        return jsonify({"error": "Model not found"}), 404
    if mv.file_path:
        full_path = os.path.join(BASE_DIR, mv.file_path)
        if os.path.isfile(full_path):
            os.remove(full_path)
    db.session.delete(mv)
    db.session.commit()
    return jsonify({"ok": True})


@api.route("/api/admin/models/<int:model_id>/rename", methods=["POST"])
def admin_rename_model(model_id):
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip() or None
    mv = ModelVersion.query.get(model_id)
    if not mv:
        return jsonify({"error": "Model not found"}), 404
    mv.name = name
    db.session.commit()
    return jsonify({"ok": True, "name": mv.name})


@api.route("/api/admin/train-model", methods=["POST"])
def admin_train_model():
    data = request.get_json(silent=True) or {}
    user_id  = data.get("userId")
    file_ids = data.get("trainingFileIds", [])
    if not user_id or not file_ids:
        return jsonify({"error": "userId and trainingFileIds required"}), 400
    user = db.session.get(User, user_id)
    if not user:
        return jsonify({"error": "User not found"}), 404
    files = TrainingFile.query.filter(
        TrainingFile.id.in_(file_ids), TrainingFile.user_id == user_id,
    ).all()
    if not files:
        return jsonify({"error": "No matching training files found"}), 404
    tf_rows = []
    for f in files:
        gesture_order = json.loads(f.gestures) if f.gestures else []
        tf_rows.append({
            "id": f.id, "file_name": f.file_name,
            "file_path": f.file_path, "gestures": gesture_order,
            "session_id": f.session_id,
        })
    logs = []
    try:
        from train_model import train_model
        result = train_model(tf_rows, {"id": user.id, "username": user.username},
                             on_log=lambda msg: logs.append(msg))
    except Exception as e:
        return jsonify({"error": str(e), "logs": logs}), 500
    max_ver = db.session.query(db.func.max(ModelVersion.version_number)).filter_by(user_id=user_id).scalar() or 0
    ModelVersion.query.filter_by(user_id=user_id, is_active=True).update({"is_active": False})
    mv = ModelVersion(
        user_id=user_id, version_number=max_ver + 1,
        training_date=datetime.now(timezone.utc),
        accuracy=result["accuracy"], file_path=result["model_path"],
        training_file_ids=json.dumps(file_ids), is_active=True,
    )
    db.session.add(mv)
    db.session.commit()
    logs.append(f"✓ Model v{mv.version_number} saved (id={mv.id})")
    return jsonify({
        "modelId": mv.id, "versionNumber": mv.version_number,
        "accuracy": result["accuracy"], "filePath": result["model_path"],
        "nSamples": result["n_samples"], "logs": logs,
    })


# ── Settings: runtime config ────────────────────────────────────────────────

@api.route("/api/settings/config/<int:user_id>", methods=["GET"])
def get_config(user_id):
    user = db.session.get(User, user_id)
    return jsonify({
        "tOn": state.runtime_config["t_on"],
        "tOff": state.runtime_config["t_off"],
        "minVotes": state.runtime_config["min_votes"],
        "gestureS": GESTURE_S,
        "restS": REST_S,
        "repsPerGesture": REPS_PER_GESTURE,
    })


@api.route("/api/settings/config/<int:user_id>", methods=["POST"])
def update_config(user_id):
    data = request.get_json(silent=True) or {}
    user = db.session.get(User, user_id)
    if "tOn" in data:
        val = float(data["tOn"])
        state.runtime_config["t_on"] = val
        if user:
            user.pref_t_on = val
    if "tOff" in data:
        val = float(data["tOff"])
        state.runtime_config["t_off"] = val
        if user:
            user.pref_t_off = val
    if "minVotes" in data:
        val = int(data["minVotes"])
        state.runtime_config["min_votes"] = val
        if user:
            user.pref_min_votes = val
    if user:
        db.session.commit()
    # broadcast updated config to all connected clients (e.g. Predict page)
    if _socketio:
        _socketio.emit("config_state", {
            "t_on": state.runtime_config["t_on"],
            "t_off": state.runtime_config["t_off"],
            "min_votes": state.runtime_config["min_votes"],
            "model_path": os.path.basename(state.runtime_config["model_path"]) if state.runtime_config["model_path"] else None,
        })
    return jsonify({"ok": True})

@api.route("/api/settings/profile/<int:user_id>", methods=["GET"])
def get_profile(user_id):
    user = db.session.get(User, user_id)
    if not user:
        return jsonify({"error": "User not found"}), 404
    return jsonify({
        "id": user.id, "firstName": user.first_name,
        "lastName": user.last_name, "username": user.username,
    })


@api.route("/api/settings/profile/<int:user_id>", methods=["POST"])
def update_profile(user_id):
    user = db.session.get(User, user_id)
    if not user:
        return jsonify({"error": "User not found"}), 404
    data = request.get_json(silent=True) or {}
    first = (data.get("firstName") or "").strip()
    last = (data.get("lastName") or "").strip()
    if first:
        user.first_name = first
    if last:
        user.last_name = last
    db.session.commit()
    return jsonify({
        "ok": True, "firstName": user.first_name, "lastName": user.last_name,
    })


@api.route("/api/settings/password/<int:user_id>", methods=["POST"])
def change_password(user_id):
    user = db.session.get(User, user_id)
    if not user:
        return jsonify({"error": "User not found"}), 404
    data = request.get_json(silent=True) or {}
    current = data.get("currentPassword") or ""
    new_pw  = data.get("newPassword") or ""
    if not current or not new_pw:
        return jsonify({"error": "Both current and new password required"}), 400
    if not check_password_hash(user.password_hash, current):
        return jsonify({"error": "Current password is incorrect"}), 403
    if len(new_pw) < 1:
        return jsonify({"error": "Password too short"}), 400
    user.password_hash = generate_password_hash(new_pw)
    db.session.commit()
    return jsonify({"ok": True})


# ── Settings: data management ───────────────────────────────────────────────

@api.route("/api/settings/files/<int:user_id>", methods=["GET"])
def user_training_files(user_id):
    files = TrainingFile.query.filter_by(user_id=user_id).order_by(TrainingFile.id.desc()).all()
    return jsonify([{
        "id": f.id, "fileName": f.file_name, "filePath": f.file_path,
        "createdAt": f.created_at.isoformat() if f.created_at else None,
    } for f in files])


@api.route("/api/settings/files/<int:file_id>", methods=["DELETE"])
def delete_training_file(file_id):
    f = db.session.get(TrainingFile, file_id)
    if not f:
        return jsonify({"error": "File not found"}), 404
    # delete the file from disk
    full_path = os.path.join(BASE_DIR, f.file_path) if not os.path.isabs(f.file_path) else f.file_path
    if os.path.exists(full_path):
        os.remove(full_path)
    db.session.delete(f)
    db.session.commit()
    return jsonify({"ok": True})


# ── Settings: user models ───────────────────────────────────────────────────

@api.route("/api/settings/models/<int:user_id>", methods=["GET"])
def user_models(user_id):
    models = ModelVersion.query.filter_by(user_id=user_id).order_by(ModelVersion.version_number.desc()).all()
    return jsonify([{
        "id": m.id, "versionNumber": m.version_number,
        "name": m.name, "accuracy": round(m.accuracy, 1) if m.accuracy else None,
        "isActive": m.is_active,
        "trainingDate": m.training_date.isoformat() if m.training_date else None,
    } for m in models])


@api.route("/api/settings/models/<int:user_id>/set-active", methods=["POST"])
def user_set_active_model(user_id):
    data = request.get_json(silent=True) or {}
    model_id = data.get("modelId")
    if not model_id:
        return jsonify({"error": "modelId required"}), 400
    ModelVersion.query.filter_by(user_id=user_id, is_active=True).update({"is_active": False})
    mv = db.session.get(ModelVersion, model_id)
    if mv and mv.user_id == user_id:
        mv.is_active = True
    db.session.commit()
    return jsonify({"ok": True})
