# JobOps Automation Commands (Pan-India Remote & Hybrid Focus)

## Step 0: Launch Visual Web Application Dashboard
```bash
npm run dashboard
# Open http://localhost:3000 in your browser
```

## Step 1: Open Chrome Session (Run Once)
```bash
npx ts-node src/index.ts launch-chrome
```

## Step 2a: Scan LinkedIn Remote & Hybrid Easy Apply Jobs
```bash
npx ts-node src/index.ts linkedin-scan --query "Angular Developer" --location "India" --pages 3
```

## Step 2b: Scan Indeed Remote & Hybrid Easily Apply Jobs
```bash
npx ts-node src/index.ts indeed-scan --query "Angular Developer" --location "India" --pages 3
```

## Step 2c: Scan Naukri.com Remote & Hybrid Jobs
```bash
npx ts-node src/index.ts naukri-scan --query "Angular Developer" --location "India" --pages 3
```

## Step 3: Evaluate Scanned Jobs with Gemini AI Matcher
```bash
npx ts-node src/index.ts evaluate
```

## Step 4a: Run LinkedIn Hands-Free AI Auto-Apply
```bash
npx ts-node src/index.ts linkedin-apply --min-score 2.5 --auto
```

## Step 4b: Run Indeed Hands-Free AI Auto-Apply
```bash
npx ts-node src/index.ts indeed-apply --min-score 2.5 --auto
```

## Step 4c: Run Naukri.com Hands-Free AI Auto-Apply (with Chatbot Solver)
```bash
npx ts-node src/index.ts naukri-apply --min-score 2.5 --auto
```

## Step 5: Check Dashboard & Application History
```bash
npx ts-node src/index.ts status
```
