# JobOps Automation Commands (Multi-Platform: Naukri.com, LinkedIn & Indeed)

---

## 🌐 Step 0: Launch Visual Web Application Dashboard
```bash
npm run dashboard
# Open http://localhost:3000 in your browser
```

---

## 🚀 Step 1: Open Chrome Session (Run Once)
```bash
npx ts-node src/index.ts launch-chrome
```
> **Important**: Once the Chrome window opens, make sure you are logged into **Naukri.com**, **LinkedIn**, and **Indeed** so your session cookies are preserved.

---

## 🔍 Step 2: Scan Jobs by Platform

### 🔵 2a. Scan Naukri.com Jobs
```bash
npx ts-node src/index.ts naukri-scan --query "Angular Developer" --location "India" --pages 3
```

### 🔷 2b. Scan LinkedIn Easy Apply Jobs
```bash
# Default: Scans past 15 days (Easy Apply + Remote & Hybrid + Auto-Scrolls 25 jobs/page)
npx ts-node src/index.ts linkedin-scan --query "Angular Developer" --location "India" --pages 8

# Custom time filter options: 15d, month (30d), week (7d), 24h, or all
npx ts-node src/index.ts linkedin-scan --query "Angular Developer" --location "India" --pages 8 --time 15d
npx ts-node src/index.ts linkedin-scan --query "Angular Developer" --location "India" --pages 8 --time month
```

### 🟣 2c. Scan Indeed India Easily Apply Jobs
```bash
npx ts-node src/index.ts indeed-scan --query "Angular Developer" --location "India" --pages 3
```

---

## ⚡ Step 3: Evaluate Scanned Jobs with Match Engine
```bash
# Evaluates scanned jobs against candidate profile (profile.yml)
npx ts-node src/index.ts evaluate

# Re-evaluate all jobs (including previously skipped frontend jobs)
npx ts-node src/index.ts evaluate --all
```
> Evaluates all jobs across all platforms against your candidate profile (`profile.yml`) and scores them from **1.0 to 5.0**. Fully matches Angular, AngularJS, Ionic, and Frontend/UI Developer positions.

---

## 🤖 Step 4: Run Hands-Free AI Auto-Apply

### 🔵 4a. Naukri.com Hands-Free Auto-Apply (with AI Chatbot Solver)
```bash
npx ts-node src/index.ts naukri-apply --min-score 2.5 --auto
```

### 🔷 4b. LinkedIn Hands-Free Auto-Apply
```bash
npx ts-node src/index.ts linkedin-apply --min-score 2.5 --auto
```

### 🟣 4c. Indeed Hands-Free Auto-Apply
```bash
npx ts-node src/index.ts indeed-apply --min-score 2.5 --auto
```

---

## 🎯 Step 4d: Apply to a Specific Job by ID
```bash
# Naukri Job ID example
npx ts-node src/index.ts naukri-apply --id "naukri_101025014953" --auto

# LinkedIn Job ID example
npx ts-node src/index.ts linkedin-apply --id "4158932401" --auto

# Indeed Job ID example
npx ts-node src/index.ts indeed-apply --id "indeed_a1b2c3d4" --auto
```

---

## 📊 Step 5: Check Application Status & History
```bash
npx ts-node src/index.ts status
```
> Displays total scanned jobs, applications submitted, skipped/pending counts, and itemized breakdown for LinkedIn, Indeed, and Naukri.com.

---

## ⚙️ Useful Flags & Customizations

| Flag | Default | Description |
| :--- | :---: | :--- |
| `--min-score <score>` | `2.5` | Minimum threshold score (e.g. `3.0` for top matches only) |
| `--auto` | `false` | 100% hands-free mode. Omit flag for interactive confirmation `[y/N]` before each submit |
| `--limit <n>` | `25` | Max applications per session (anti-ban safety cap) |
| `--pages <number>` | `5` | Number of search result pages to scan (~25 jobs per page on LinkedIn) |
| `-t, --time <value>` | `15d` | LinkedIn time posted filter (`15d`, `month`, `week`, `24h`, `all`) |
| `--days <number>` | `15` | Shortcut for days posted filter on LinkedIn (e.g. `--days 15`) |
| `--all` | `false` | For `evaluate`: re-evaluates all jobs including previously skipped |
| `--headed` | `false` | Run browser in visible window instead of background |

---

## 🧹 Maintenance & Cache Management

### Reset Knowledge Base Answers Cache
```bash
# Reset entire cache back to safe defaults
npx ts-node src/index.ts reset-cache

# Delete only a specific cached question
npx ts-node src/index.ts reset-cache --key "notice period"
```
