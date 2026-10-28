import os

import cv2

# Set the password before running, so it never ends up in the code or on Git:
#   PowerShell:  $env:CAMERA_PASSWORD = "..." ; python index.py
CAMERA_IP = os.getenv("CAMERA_IP", "192.168.254.64")
USERNAME = os.getenv("CAMERA_USERNAME", "admin")
PASSWORD = os.getenv("CAMERA_PASSWORD")

if not PASSWORD:
    print("Set the CAMERA_PASSWORD environment variable first.")
    exit()

url = (
    f"rtsp://{USERNAME}:{PASSWORD}@{CAMERA_IP}:554"
    "/Streaming/Channels/101"
)

cap = cv2.VideoCapture(url)

if not cap.isOpened():
    print("Cannot connect to camera.")
    exit()

print("Camera connected. Press Q to quit.")

while True:
    ret, frame = cap.read()

    if not ret:
        print("Failed to receive frame.")
        break

    cv2.imshow("IP Camera Feed", frame)

    if cv2.waitKey(1) & 0xFF == ord("q"):
        break

cap.release()
cv2.destroyAllWindows()
