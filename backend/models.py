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
    is_admin = db.Column(db.Boolean, default=False, nullable=False)
    training_streak = db.Column(db.Integer, default=0, nullable=False)

    # per-user signal thresholds (persisted between sessions)
    pref_t_on = db.Column(db.Float)
    pref_t_off = db.Column(db.Float)
    pref_min_votes = db.Column(db.Integer)

    # relationships
    user_gestures = db.relationship("UserGesture", back_populates="user", cascade="all, delete-orphan")
    sessions = db.relationship("Session", back_populates="user", cascade="all, delete-orphan")
    testing_trials = db.relationship("TestingTrial", back_populates="user", cascade="all, delete-orphan")
    model_versions = db.relationship("ModelVersion", back_populates="user", cascade="all, delete-orphan")
    training_files = db.relationship("TrainingFile", back_populates="user", cascade="all, delete-orphan")


class Gesture(db.Model):
    __tablename__ = "gestures"

    id = db.Column(db.Integer, primary_key=True)
    gesture_name = db.Column(db.String(100), unique=True, nullable=False)
    gesture_image = db.Column(db.String(300))  # path or URL to image/animation

    user_gestures = db.relationship("UserGesture", back_populates="gesture")
    training_gestures = db.relationship("TrainingGesture", back_populates="gesture")
    testing_trials = db.relationship("TestingTrial", back_populates="gesture")


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
    session_name = db.Column(db.Text)
    mode = db.Column(db.Text)

    user = db.relationship("User", back_populates="sessions")
    training_gestures = db.relationship("TrainingGesture", back_populates="session", cascade="all, delete-orphan")
    testing_trials = db.relationship("TestingTrial", back_populates="session", cascade="all, delete-orphan")
    training_files = db.relationship("TrainingFile", back_populates="session", cascade="all, delete-orphan")


class TrainingGesture(db.Model):
    __tablename__ = "training_gestures"

    id = db.Column(db.Integer, primary_key=True)
    session_id = db.Column(db.Integer, db.ForeignKey("sessions.id"), nullable=False)
    gesture_id = db.Column(db.Integer, db.ForeignKey("gestures.id"), nullable=False)
    display_order = db.Column(db.Integer, nullable=False)
    completed = db.Column(db.Boolean, default=True, nullable=False)

    session = db.relationship("Session", back_populates="training_gestures")
    gesture = db.relationship("Gesture", back_populates="training_gestures")


class TestingTrial(db.Model):
    __tablename__ = "testing_trials"

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False)
    session_id = db.Column(db.Integer, db.ForeignKey("sessions.id"), nullable=False)
    gesture_id = db.Column(db.Integer, db.ForeignKey("gestures.id"), nullable=False)
    display_order = db.Column(db.Integer, nullable=False)
    trial_number = db.Column(db.Integer, nullable=False)
    ground_truth = db.Column(db.String(100))
    prediction = db.Column(db.String(100))
    confidence = db.Column(db.Float)
    retry_count = db.Column(db.Integer, default=0, nullable=False)
    was_correct = db.Column(db.Boolean)
    was_skipped = db.Column(db.Boolean, default=False, nullable=False)

    user = db.relationship("User", back_populates="testing_trials")
    session = db.relationship("Session", back_populates="testing_trials")
    gesture = db.relationship("Gesture", back_populates="testing_trials")


class ModelVersion(db.Model):
    __tablename__ = "model_versions"

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False)
    version_number = db.Column(db.Integer, nullable=False)
    name = db.Column(db.String(100))  # optional user-given name
    training_date = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)
    accuracy = db.Column(db.Float)
    file_path = db.Column(db.String(500))
    training_file_ids = db.Column(db.Text)  # JSON list of TrainingFile IDs used
    is_active = db.Column(db.Boolean, default=False, nullable=False)

    user = db.relationship("User", back_populates="model_versions")


class TrainingFile(db.Model):
    __tablename__ = "training_files"

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False)
    session_id = db.Column(db.Integer, db.ForeignKey("sessions.id"))
    file_name = db.Column(db.String(300), nullable=False)
    file_path = db.Column(db.String(500), nullable=False)
    num_samples = db.Column(db.Integer, default=0, nullable=False)
    gestures = db.Column(db.Text)  # JSON list of gesture names
    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)

    user = db.relationship("User", back_populates="training_files")
    session = db.relationship("Session", back_populates="training_files")
