"""
SQLAlchemy models for the EMG Gesture Classifier.
"""
from datetime import datetime, timezone
from flask_sqlalchemy import SQLAlchemy

db = SQLAlchemy()


class User(db.Model):
    __tablename__ = "users"

    id = db.Column(db.Integer, primary_key=True)
    first_name = db.Column(db.String(100), nullable=False)
    last_name = db.Column(db.String(100), nullable=False)
    username = db.Column(db.String(100), unique=True, nullable=False)
    password_hash = db.Column(db.String(256), nullable=False)
    last_login = db.Column(db.DateTime)
    is_active = db.Column(db.Boolean, default=True, nullable=False)
    training_streak = db.Column(db.Integer, default=0, nullable=False)

    # relationships
    user_gestures = db.relationship("UserGesture", back_populates="user", cascade="all, delete-orphan")
    sessions = db.relationship("Session", back_populates="user", cascade="all, delete-orphan")
    gesture_trials = db.relationship("GestureTrial", back_populates="user", cascade="all, delete-orphan")
    model_versions = db.relationship("ModelVersion", back_populates="user", cascade="all, delete-orphan")


class Gesture(db.Model):
    __tablename__ = "gestures"

    id = db.Column(db.Integer, primary_key=True)
    gesture_name = db.Column(db.String(100), unique=True, nullable=False)
    gesture_image = db.Column(db.String(300))  # path or URL to image/animation

    user_gestures = db.relationship("UserGesture", back_populates="gesture")
    session_gestures = db.relationship("SessionGesture", back_populates="gesture")
    gesture_trials = db.relationship("GestureTrial", back_populates="gesture")


class UserGesture(db.Model):
    __tablename__ = "user_gestures"

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False)
    gesture_id = db.Column(db.Integer, db.ForeignKey("gestures.id"), nullable=False)
    accuracy = db.Column(db.Float, default=0.0)
    needs_retraining = db.Column(db.Boolean, default=True, nullable=False)
    is_enabled = db.Column(db.Boolean, default=True, nullable=False)
    is_unlocked = db.Column(db.Boolean, default=False, nullable=False)
    times_trained = db.Column(db.Integer, default=0, nullable=False)       # sessions where trained
    times_tested = db.Column(db.Integer, default=0, nullable=False)        # sessions where tested
    total_times_trained = db.Column(db.Integer, default=0, nullable=False)  # total reps trained
    total_times_tested = db.Column(db.Integer, default=0, nullable=False)   # total reps tested
    correct_predictions = db.Column(db.Integer, default=0, nullable=False)
    incorrect_predictions = db.Column(db.Integer, default=0, nullable=False)
    average_confidence = db.Column(db.Float, default=0.0)

    user = db.relationship("User", back_populates="user_gestures")
    gesture = db.relationship("Gesture", back_populates="user_gestures")

    __table_args__ = (
        db.UniqueConstraint("user_id", "gesture_id", name="uq_user_gesture"),
    )


class Session(db.Model):
    __tablename__ = "sessions"

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False)
    session_type = db.Column(db.String(20), nullable=False)  # 'training' | 'testing'
    planned_duration = db.Column(db.Float)   # seconds
    actual_duration = db.Column(db.Float)    # seconds
    status = db.Column(db.String(20), default="scheduled", nullable=False)  # scheduled | in_progress | completed | aborted
    started_at = db.Column(db.DateTime)
    ended_at = db.Column(db.DateTime)
    number_of_connected_channels = db.Column(db.Integer)

    user = db.relationship("User", back_populates="sessions")
    session_gestures = db.relationship("SessionGesture", back_populates="session", cascade="all, delete-orphan")
    gesture_trials = db.relationship("GestureTrial", back_populates="session", cascade="all, delete-orphan")


class SessionGesture(db.Model):
    __tablename__ = "session_gestures"

    id = db.Column(db.Integer, primary_key=True)
    session_id = db.Column(db.Integer, db.ForeignKey("sessions.id"), nullable=False)
    gesture_id = db.Column(db.Integer, db.ForeignKey("gestures.id"), nullable=False)
    display_order = db.Column(db.Integer, nullable=False)
    target_repetitions = db.Column(db.Integer, default=1, nullable=False)
    completed_repetitions = db.Column(db.Integer, default=0, nullable=False)
    was_skipped = db.Column(db.Boolean, default=False, nullable=False)

    session = db.relationship("Session", back_populates="session_gestures")
    gesture = db.relationship("Gesture", back_populates="session_gestures")
    gesture_trials = db.relationship("GestureTrial", back_populates="session_gesture", cascade="all, delete-orphan")


class GestureTrial(db.Model):
    __tablename__ = "gesture_trials"

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False)
    session_id = db.Column(db.Integer, db.ForeignKey("sessions.id"), nullable=False)
    session_gesture_id = db.Column(db.Integer, db.ForeignKey("session_gestures.id"), nullable=False)
    gesture_id = db.Column(db.Integer, db.ForeignKey("gestures.id"), nullable=False)
    trial_number = db.Column(db.Integer, nullable=False)
    attempt_type = db.Column(db.String(20), nullable=False)  # training | testing | retraining
    ground_truth = db.Column(db.String(100))
    prediction = db.Column(db.String(100))
    confidence = db.Column(db.Float)
    retry_count = db.Column(db.Integer, default=0, nullable=False)
    was_correct = db.Column(db.Boolean)
    was_skipped = db.Column(db.Boolean, default=False, nullable=False)

    user = db.relationship("User", back_populates="gesture_trials")
    session = db.relationship("Session", back_populates="gesture_trials")
    session_gesture = db.relationship("SessionGesture", back_populates="gesture_trials")
    gesture = db.relationship("Gesture", back_populates="gesture_trials")


class ModelVersion(db.Model):
    __tablename__ = "model_versions"

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False)
    version_number = db.Column(db.Integer, nullable=False)
    training_date = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)
    accuracy = db.Column(db.Float)
    file_path = db.Column(db.String(500))
    is_active = db.Column(db.Boolean, default=False, nullable=False)

    user = db.relationship("User", back_populates="model_versions")
