# JobOps Automation Commands (Pan-India Remote & Hybrid Focus)

## Step 1: Open Chrome Session (Run Once)
```bash
npx ts-node src/index.ts launch-chrome
```

## Step 2: Scan Pan-India Remote & Hybrid Easy Apply Jobs
```bash
npx ts-node src/index.ts linkedin-scan --query "Angular Developer" --location "India" --pages 3
```

## Step 3: Evaluate Scanned Jobs with Gemini 2.5 Flash AI
```bash
npx ts-node src/index.ts evaluate
```

## Step 4: Run 100% Hands-Free AI Auto-Apply
```bash
npx ts-node src/index.ts linkedin-apply --min-score 2.5 --auto
```

## Step 5: Check Dashboard & Application History
```bash
npx ts-node src/index.ts status
```
