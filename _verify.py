import numpy as np
import json

d = np.load('training_data/kate/training_20260321_191149.npz', allow_pickle=True)
labels = list(d['labels'])

print(f"Total gestures recorded: {len(labels)}")
print(f"Fs: {d['Fs']}")
print()

print("Labels in order:")
for i, l in enumerate(labels):
    print(f"  {i+1:2d}. {l}")

print()
gesture_keys = [k for k in d.keys() if k.startswith('gesture_') and k != 'gesture_classes']
print(f"Gesture data arrays: {len(gesture_keys)}")
for k in sorted(gesture_keys, key=lambda x: int(x.split('_')[1])):
    print(f"  {k}: shape={d[k].shape}, dtype={d[k].dtype}")
