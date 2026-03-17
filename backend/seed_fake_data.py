"""
Seed the database with fake data for user 'alyshia' to preview the dashboard.
Run:  python seed_fake_data.py
"""
import os, sys, random
from datetime import datetime, timedelta, timezone
from werkzeug.security import generate_password_hash

# ensure we can import from this directory
sys.path.insert(0, os.path.dirname(__file__))

from app import app
from models import db, User, Gesture, UserGesture, Session, SessionGesture, GestureTrial, ModelVersion

random.seed(42)

def seed():
    with app.app_context():
        db.create_all()

        # ── Ensure gestures are seeded ──
        if Gesture.query.count() == 0:
            for name, img in [
                ("Open", "/gestures/open.jpg"), ("Close", "/gestures/close.jpg"),
                ("Thumbs Up", "/gestures/thumbs_up.jpg"), ("Peace", "/gestures/peace.jpg"),
                ("Index Point", "/gestures/index_point.jpg"), ("Four", "/gestures/four.jpg"),
                ("Okay", "/gestures/okay.jpg"), ("Spiderman", "/gestures/spiderman.jpg"),
            ]:
                db.session.add(Gesture(gesture_name=name, gesture_image=img))
            db.session.commit()

        gestures = Gesture.query.order_by(Gesture.id).all()

        # ── Create or reset user 'alyshia' ──
        user = User.query.filter_by(username="alyshia").first()
        if user:
            # wipe existing child data
            GestureTrial.query.filter_by(user_id=user.id).delete()
            SessionGesture.query.filter(
                SessionGesture.session_id.in_(
                    [s.id for s in Session.query.filter_by(user_id=user.id).all()]
                )
            ).delete(synchronize_session=False)
            Session.query.filter_by(user_id=user.id).delete()
            UserGesture.query.filter_by(user_id=user.id).delete()
            ModelVersion.query.filter_by(user_id=user.id).delete()
            user.training_streak = 5
            user.last_login = datetime.now(timezone.utc)
        else:
            user = User(
                first_name="Alyshia",
                last_name="Leung",
                username="alyshia",
                password_hash=generate_password_hash("password"),
                last_login=datetime.now(timezone.utc),
                is_active=True,
                training_streak=5,
            )
            db.session.add(user)
        db.session.commit()

        # ── Per-gesture accuracy profiles (some strong, some weak) ──
        profiles = {
            "Open":        {"acc": 92, "conf": 0.94, "trained": 45, "tested": 38, "unlocked": True, "retrain": False},
            "Close":       {"acc": 87, "conf": 0.89, "trained": 40, "tested": 35, "unlocked": True, "retrain": False},
            "Thumbs Up":   {"acc": 78, "conf": 0.81, "trained": 35, "tested": 30, "unlocked": True, "retrain": False},
            "Peace":       {"acc": 65, "conf": 0.70, "trained": 30, "tested": 28, "unlocked": True, "retrain": False},
            "Index Point": {"acc": 52, "conf": 0.58, "trained": 25, "tested": 22, "unlocked": True, "retrain": True},
            "Four":        {"acc": 43, "conf": 0.50, "trained": 20, "tested": 18, "unlocked": True, "retrain": True},
            "Okay":        {"acc": 0,  "conf": 0.0,  "trained": 5,  "tested": 0,  "unlocked": True, "retrain": True},
            "Spiderman":   {"acc": 0,  "conf": 0.0,  "trained": 0,  "tested": 0,  "unlocked": False, "retrain": True},
        }

        for g in gestures:
            p = profiles[g.gesture_name]
            correct = int(p["tested"] * p["acc"] / 100) if p["tested"] > 0 else 0
            incorrect = p["tested"] - correct
            ug = UserGesture(
                user_id=user.id,
                gesture_id=g.id,
                accuracy=p["acc"],
                needs_retraining=p["retrain"],
                is_enabled=True,
                is_unlocked=p["unlocked"],
                times_trained=min(p["trained"] // 5, 8),
                times_tested=min(p["tested"] // 5, 6),
                total_times_trained=p["trained"],
                total_times_tested=p["tested"],
                correct_predictions=correct,
                incorrect_predictions=incorrect,
                average_confidence=p["conf"],
            )
            db.session.add(ug)
        db.session.commit()

        # ── Sessions (mix of training + testing over the past 2 weeks) ──
        now = datetime.now(timezone.utc)
        session_defs = [
            {"type": "training", "status": "completed", "days_ago": 13, "dur": 420},
            {"type": "training", "status": "completed", "days_ago": 11, "dur": 360},
            {"type": "testing",  "status": "completed", "days_ago": 10, "dur": 300},
            {"type": "training", "status": "completed", "days_ago": 8,  "dur": 480},
            {"type": "testing",  "status": "completed", "days_ago": 7,  "dur": 240},
            {"type": "training", "status": "completed", "days_ago": 5,  "dur": 390},
            {"type": "testing",  "status": "completed", "days_ago": 4,  "dur": 350},
            {"type": "training", "status": "completed", "days_ago": 3,  "dur": 300},
            {"type": "testing",  "status": "completed", "days_ago": 2,  "dur": 280},
            {"type": "training", "status": "completed", "days_ago": 1,  "dur": 420},
            {"type": "testing",  "status": "aborted",   "days_ago": 0,  "dur": 90},
        ]

        sessions = []
        for sd in session_defs:
            start = now - timedelta(days=sd["days_ago"], hours=random.randint(1, 12))
            end = start + timedelta(seconds=sd["dur"])
            s = Session(
                user_id=user.id,
                session_type=sd["type"],
                planned_duration=sd["dur"] + random.randint(-30, 60),
                actual_duration=sd["dur"],
                status=sd["status"],
                started_at=start,
                ended_at=end,
                number_of_connected_channels=64,
            )
            db.session.add(s)
            db.session.flush()  # get s.id
            sessions.append(s)

        db.session.commit()

        # ── Session gestures + gesture trials ──
        unlocked_gestures = [g for g in gestures if profiles[g.gesture_name]["unlocked"]]

        for s in sessions:
            # pick 5-8 random gestures for this session
            n_gest = random.randint(5, min(8, len(unlocked_gestures)))
            chosen = random.sample(unlocked_gestures, n_gest)

            for order, g in enumerate(chosen, 1):
                p = profiles[g.gesture_name]
                target_reps = random.randint(3, 5)
                completed = target_reps if s.status == "completed" else random.randint(0, target_reps - 1)
                sg = SessionGesture(
                    session_id=s.id,
                    gesture_id=g.id,
                    display_order=order,
                    target_repetitions=target_reps,
                    completed_repetitions=completed,
                    was_skipped=(s.status == "aborted" and random.random() < 0.3),
                )
                db.session.add(sg)
                db.session.flush()

                # create individual trials
                for trial_num in range(1, completed + 1):
                    is_correct = random.random() < (p["acc"] / 100) if p["acc"] > 0 else False
                    conf = max(0.3, min(1.0, p["conf"] + random.uniform(-0.15, 0.15)))
                    gt = g.gesture_name
                    pred = gt if is_correct else random.choice([x.gesture_name for x in unlocked_gestures if x.id != g.id])

                    trial = GestureTrial(
                        user_id=user.id,
                        session_id=s.id,
                        session_gesture_id=sg.id,
                        gesture_id=g.id,
                        trial_number=trial_num,
                        attempt_type=s.session_type,
                        ground_truth=gt,
                        prediction=pred,
                        confidence=round(conf, 3),
                        retry_count=0 if is_correct else random.randint(0, 2),
                        was_correct=is_correct,
                        was_skipped=False,
                    )
                    db.session.add(trial)

        db.session.commit()

        # ── Model versions ──
        for v in range(1, 4):
            mv = ModelVersion(
                user_id=user.id,
                version_number=v,
                training_date=now - timedelta(days=14 - v * 4),
                accuracy=60 + v * 10,
                file_path=f"models/alyshia_v{v}.pkl",
                is_active=(v == 3),
            )
            db.session.add(mv)
        db.session.commit()

        # ── Summary ──
        print(f"✓ User: {user.username} (id={user.id})")
        print(f"  Streak: {user.training_streak}")
        print(f"  User gestures: {UserGesture.query.filter_by(user_id=user.id).count()}")
        print(f"  Sessions: {Session.query.filter_by(user_id=user.id).count()}")
        print(f"  Session gestures: {sum(len(s.session_gestures) for s in sessions)}")
        print(f"  Gesture trials: {GestureTrial.query.filter_by(user_id=user.id).count()}")
        print(f"  Model versions: {ModelVersion.query.filter_by(user_id=user.id).count()}")
        print(f"\n  Login: username='alyshia', password='password'")

if __name__ == "__main__":
    seed()
