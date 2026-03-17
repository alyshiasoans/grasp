import random
import csv
from datetime import datetime
import cv2
import numpy as np

# List of gestures
gestures = [
    "Close",
    "Thumbs up",
    "Spiderman",
    "Index point",
    "Peace",
    "Okay",
    "Four",
    "Open"
]

# Repeat each item 5 times
gesture_list = gestures * 5

# Randomize the list
random.shuffle(gesture_list)

# Save the order to a CSV file
timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
csv_filename = f"gesture_order_{timestamp}.csv"
with open(csv_filename, 'w', newline='') as csvfile:
    writer = csv.writer(csvfile)
    writer.writerow(['Order', 'Gesture'])
    for i, gesture in enumerate(gesture_list, 1):
        writer.writerow([i, gesture])
print(f"Gesture order saved to {csv_filename}")

# Video settings
WIDTH = 1920
HEIGHT = 1080
FPS = 30
DURATION_PER_STATE = 3  # seconds per gesture/relax

def create_frame(progress_text, gesture_text, countdown_text, gesture_color=(255, 255, 255), countdown_color=(0, 255, 255), next_gesture=None):
    """Create a single frame with the gesture display"""
    # Create black background
    frame = np.zeros((HEIGHT, WIDTH, 3), dtype=np.uint8)
    
    # Font settings
    font = cv2.FONT_HERSHEY_SIMPLEX
    
    # Progress text (top, gray)
    if progress_text:
        text_size = cv2.getTextSize(progress_text, font, 1.5, 2)[0]
        x = (WIDTH - text_size[0]) // 2
        cv2.putText(frame, progress_text, (x, 80), font, 1.5, (128, 128, 128), 2)
    
    # Main gesture text (center)
    text_size = cv2.getTextSize(gesture_text, font, 4, 6)[0]
    x = (WIDTH - text_size[0]) // 2
    y = (HEIGHT + text_size[1]) // 2
    cv2.putText(frame, gesture_text, (x, y), font, 4, gesture_color, 6)
    
    # Next gesture text (smaller, below main gesture)
    if next_gesture:
        next_text = f"Next: {next_gesture}"
        text_size = cv2.getTextSize(next_text, font, 1.5, 2)[0]
        x = (WIDTH - text_size[0]) // 2
        cv2.putText(frame, next_text, (x, y + 100), font, 1.5, (128, 128, 128), 2)
    
    # Countdown text (bottom)
    if countdown_text:
        text_size = cv2.getTextSize(countdown_text, font, 3, 4)[0]
        x = (WIDTH - text_size[0]) // 2
        cv2.putText(frame, countdown_text, (x, HEIGHT - 100), font, 3, countdown_color, 4)
    
    return frame

def generate_video(gestures, output_filename):
    """Generate video with gesture prompts"""
    # Video writer
    fourcc = cv2.VideoWriter_fourcc(*'mp4v')
    out = cv2.VideoWriter(output_filename, fourcc, FPS, (WIDTH, HEIGHT))
    
    current_index = 0
    is_relax = False
    total_gestures = len(gestures)
    
    print(f"Generating video with {total_gestures} gestures...")
    
    # Initial 6-second relax before first gesture
    print("  Adding initial 6-second relax...")
    for countdown in range(6, 0, -1):
        frame = create_frame("", "Relax", str(countdown), (255, 255, 0), (255, 255, 0), next_gesture=gestures[0])
        for _ in range(FPS):
            out.write(frame)
    
    while current_index < total_gestures:
        for countdown in range(DURATION_PER_STATE, 0, -1):
            if not is_relax:
                # Show gesture
                gesture = gestures[current_index]
                progress_text = f"[{current_index + 1}/{total_gestures}]"
                gesture_color = (255, 255, 255)  # White (BGR)
                countdown_color = (0, 255, 255)  # Yellow (BGR)
                next_gesture = None  # No next gesture preview during gesture
            else:
                # Show relax
                gesture = "Relax"
                progress_text = f"[{current_index + 1}/{total_gestures}]"
                gesture_color = (255, 255, 0)  # Cyan (BGR)
                countdown_color = (255, 255, 0)  # Cyan (BGR)
                # Show next gesture during relax (if there is one)
                next_gesture = gestures[current_index + 1] if current_index + 1 < total_gestures else None
            
            # Create frame and write for 1 second (FPS frames)
            frame = create_frame(progress_text, gesture, str(countdown), gesture_color, countdown_color, next_gesture)
            for _ in range(FPS):
                out.write(frame)
        
        # Toggle state
        if is_relax:
            current_index += 1
            print(f"  Progress: {current_index}/{total_gestures}")
        is_relax = not is_relax
    
    # Add "Complete!" frame for 3 seconds
    frame = create_frame("", "Complete!", "", (0, 255, 0), (0, 255, 0))
    for _ in range(FPS * 3):
        out.write(frame)
    
    out.release()
    print(f"Video saved to {output_filename}")

# Generate the video
video_filename = f"gesture_video_{timestamp}.mp4"
print("Starting video generation...")
generate_video(gesture_list, video_filename)
print("Complete!")