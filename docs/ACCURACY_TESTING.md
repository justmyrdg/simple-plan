# Measuring Detection and Collection Accuracy

A thesis panel will ask "How accurate is it?" This guide produces those numbers for the actual
Batangas City collection points. There are two separate questions:

1. **Detection accuracy:** does the model tell a full area from a clean one correctly?
2. **Collection tracking accuracy:** does the system's "collected / not collected" verdict match
   what really happened?

The current training photos (`Images/`) are mostly internet photos, not your sites. Testing on them
gives misleadingly high numbers, because the model was trained on them.

## 1. Collect photos from your own sites

With the camera installed at a collection point, save a photo every 5 minutes for several days.
Include mornings, afternoons, nights and rainy days, before and after pickups:

```bash
python trash_detector.py capture "rtsp://admin:PASSWORD@192.168.254.130:554/Streaming/Channels/101" --every 300 --out Images/site_raw
```

Stop it with Ctrl+C. It also works with a camera number (`0`) or a video file.

## 2. Label them

Sort the photos into folders by hand:

```
SiteData/
  train/clean/   train/trash/      ← photos from some days
  test/clean/    test/trash/       ← photos from OTHER days
```

- **Split by day, not at random.** Photos a few minutes apart look almost identical. If one ends up
  in train and its near-twin in test, the score is inflated.
- Aim for **at least 100 photos per folder** in test, with both classes balanced roughly evenly.
- Write down how you decided borderline photos (e.g. "2 or more bags = trash") and apply that rule
  consistently. Mention it in the methodology.

## 3. Train on your site photos

Combine the existing photos with your site photos, then train:

```bash
python trash_detector.py train SiteData/train
```

This writes `trash_head.pt`. Restart the backend so it loads the new model (on EC2:
`git pull` and run `deploy/setup_ec2.sh` again after committing the new `trash_head.pt`).

## 4. Evaluate on the held-out test photos

```bash
python trash_detector.py evaluate SiteData/test --save results/
```

The output looks like this (made-up example numbers, not real results):

```
model           accuracy  precision  recall  specificity     F1
trained head       93.5%      91.8%   95.2%        91.9%  0.935
zero-shot          78.0%      70.1%   97.6%        58.5%  0.816

Confusion matrix (trained head):
                    predicted trash  predicted clean
      actual trash              100                5
      actual clean                9              102
```

- **Precision:** of the photos it called trash, how many really were.
- **Recall:** of the real trash photos, how many it caught.
- **Specificity:** of the clean photos, how many it correctly called clean.
- `results/evaluation.csv` has every photo's score, for tables and charts.
- The *zero-shot* row is the untrained baseline, which shows how much training on your sites helped.
- Try `--threshold 0.4` or `--threshold 0.6` to see the trade-off between catching all trash and
  avoiding false alarms. Report the threshold you choose.

## 5. Collection tracking accuracy (field validation)

This validates goal 1 directly. For every scheduled pickup during the test period, a team member
observes (or checks with the collectors) whether the area was actually collected, and logs it:

| Date | Area | Scheduled | Truck actually came | Area actually cleaned | System verdict | Match? |
|---|---|---|---|---|---|---|
| Oct 27 | Purok 1 | 8:00 AM | 8:10 AM | Yes | Collected (8:13 AM) | ✓ |
| Oct 28 | Purok 1 | 8:00 AM | No | No | Not collected | ✓ |

The system verdicts come from **Reports → Download CSV**. Then report:

- **Agreement rate** = matching rows ÷ all rows
- How many real collections the system missed, and how many "collected" verdicts were wrong
- The average difference between the observed truck time and the system's "clean at" time

## What to put in the results chapter

1. The detection table and confusion matrix from step 4, trained versus zero-shot.
2. The field validation agreement rate from step 5.
3. The **Reports** page numbers for the study period: collection rate, on-time rate, average delay,
   hours full before pickup and time full. These show the "optimized" part of the title.
4. The limitations you observed (night, rain, people or vehicles blocking the view).
