"""
Flask + Flask-SocketIO backend for the EMG Gesture Classifier.
Streams real-time classification results to a React frontend via WebSocket.
"""

import os
import sqlite3

from flask import Flask
from flask_socketio import SocketIO
from flask_cors import CORS

from config import BASE_DIR, DB_PATH
from models import db, Gesture, UserGesture
from routes import api
from socket_handlers import register_socket_handlers


# ── Flask / SocketIO ─────────────────────────────────────────────────────────
app = Flask(__name__)
CORS(app, origins="*")

app.config["SQLALCHEMY_DATABASE_URI"] = f"sqlite:///{DB_PATH}"
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", os.urandom(32).hex())

db.init_app(app)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

# Register routes and socket handlers
app.register_blueprint(api)
register_socket_handlers(socketio, app)


# ── Database init ─────────────────────────────────────────────────────────────

def ensure_sqlite_schema():
    with sqlite3.connect(DB_PATH) as conn:
        cursor = conn.cursor()
        cursor.execute("PRAGMA table_info(users)")
        user_columns = {row[1] for row in cursor.fetchall()}
        if "is_admin" not in user_columns:
            cursor.execute("ALTER TABLE users ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT 0")
        cursor.execute("PRAGMA table_info(model_versions)")
        mv_columns = {row[1] for row in cursor.fetchall()}
        if mv_columns and "training_file_ids" not in mv_columns:
            cursor.execute("ALTER TABLE model_versions ADD COLUMN training_file_ids TEXT")
        if mv_columns and "name" not in mv_columns:
            cursor.execute("ALTER TABLE model_versions ADD COLUMN name VARCHAR(100)")
        conn.commit()


def initialize_database():
    ensure_sqlite_schema()
    db.create_all()
    if Gesture.query.count() == 0:
        for name, img in [
            ("Open", "/gestures/open.jpg"), ("Close", "/gestures/close.jpg"),
            ("Thumbs Up", "/gestures/thumbs_up.jpg"), ("Peace", "/gestures/peace.jpg"),
            ("Index Point", "/gestures/index_point.jpg"), ("Four", "/gestures/four.jpg"),
            ("Okay", "/gestures/okay.jpg"), ("Spiderman", "/gestures/spiderman.jpg"),
        ]:
            db.session.add(Gesture(gesture_name=name, gesture_image=img))
        db.session.commit()
        print("[db] seeded 8 gestures")
    starter_gestures = Gesture.query.filter(Gesture.gesture_name.in_(["Open", "Close"])).all()
    for g in starter_gestures:
        for ug in UserGesture.query.filter_by(gesture_id=g.id, is_unlocked=False).all():
            ug.is_unlocked = True
    db.session.commit()


with app.app_context():
    initialize_database()


if __name__ == "__main__":
    print("[server] starting on http://localhost:5050")
    socketio.run(app, host="0.0.0.0", port=5050, debug=False, allow_unsafe_werkzeug=True)