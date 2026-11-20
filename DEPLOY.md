# Deploying PH Grid Builder: GitHub → Northflank

This guide takes the project from your Desktop to a public website in three parts:

1. **Upload the code to GitHub**
2. **Deploy it on Northflank**
3. **Update the live site later**

**How it works:** Northflank reads the `Dockerfile` in this repository. That file builds the app with Node.js and then serves the finished website with nginx on **port 80**. You don't have to install Docker yourself; Northflank does the building.

> **Already done for you:** the project folder is already a git repository on branch `main`, with all the code committed. You only need to create the GitHub repository and push to it.

---

## Part 1 — Upload the code to GitHub

### Step 1. Sign in to GitHub
Go to **https://github.com** and sign in. If you don't have an account, create one first.

### Step 2. Create an empty repository
1. Click the **+** button (top right) → **New repository**.
2. **Repository name:** `ph-grid-builder` (or any name you like).
3. **Visibility:** choose **Public** or **Private**. Both work with Northflank.
4. **Important:** leave these **unticked / set to "None"**:
   - *Add a README file*
   - *Add .gitignore*
   - *Choose a license*

   The repository must be completely empty, or the upload in Step 4 will be rejected.
5. Click **Create repository**.

GitHub now shows a page with setup commands. Copy the HTTPS address at the top. It looks like:

```
https://github.com/YOUR-USERNAME/ph-grid-builder.git
```

### Step 3. Open PowerShell in the project folder
In File Explorer, open **Desktop → PH Grid Builder**, click the address bar, type `powershell` and press **Enter**.

Check you're in the right place:

```powershell
git status
```

You should see `On branch main` and `nothing to commit, working tree clean`.

### Step 4. Connect the folder to GitHub and upload
Replace `YOUR-USERNAME` with your GitHub username, then run:

```powershell
git remote add origin https://github.com/YOUR-USERNAME/ph-grid-builder.git
```

```powershell
git push -u origin main
```

The first time you push, a **GitHub sign-in window** opens. Choose **Sign in with your browser** and approve it. Git remembers this, so you won't be asked again.

When it finishes you'll see a line like `branch 'main' set up to track 'origin/main'`.

### Step 5. Check it on GitHub
Refresh your repository page on GitHub. You should see the `src` folder, `Dockerfile`, `nginx.conf`, `package.json` and the guides.

You should **not** see `node_modules` or `dist`. Those are deliberately excluded, and Northflank rebuilds them.

---

## Part 2 — Deploy on Northflank

### Step 6. Create a Northflank account
1. Go to **https://northflank.com** and sign up. Signing up with GitHub is easiest.
2. When asked to **select a billing plan**, choose **Developer Sandbox** (the free plan). It's enough for this app.

### Step 7. Link your GitHub account
1. In Northflank, open your team's **Git** integrations page:
   **https://app.northflank.com/s/account/integrations/vcs**
2. Click **Link GitHub**.
3. On GitHub, choose **Only select repositories**, pick `ph-grid-builder`, then click **Install & Authorize**.
4. You're sent back to Northflank, and your GitHub account name now appears next to GitHub.

### Step 8. Create a project
1. Click **Create project**.
2. **Name:** `ph-grid-builder`.
3. **Region:** choose **Asia Southeast**, the closest region to the Philippines, so the site loads faster there.
   > The region **cannot be changed** after the project is created.
4. Click **Create project**.

### Step 9. Create a combined service
A *combined service* builds your code from GitHub and runs it in one place.

1. Inside the project, click **Create service** → **Combined service**.
2. **Name:** `web`. This can't be changed later, and it becomes part of your website address.
3. **Repository:** select `ph-grid-builder`. **Branch:** `main`.
4. **Build options:** choose **Dockerfile**.
   - **Dockerfile location:** `/Dockerfile`
   - **Build context:** `/`
5. **Networking:** Northflank reads the Dockerfile and detects **port 80** automatically. Make sure it's set to:
   - **Protocol:** `HTTP`
   - **Public:** enabled

   If port 80 isn't listed, click **Add port** and enter it yourself.
6. **Resources:** leave the default (smallest) plan. The app is a static website, so it needs very little.
7. *(Optional)* **Advanced → Health checks:** add an HTTP check on port `80`, path `/healthz`.
8. Click **Create service**.

### Step 10. Wait for the build
Northflank now builds your app. You can watch it under the service's **Builds** tab.

- The build takes about **2–4 minutes**.
- A successful build ends with `✓ built in …` followed by the nginx image steps.
- After the build, the service deploys and its status turns to **Running**.

### Step 11. Open your live site
In the service header, find **Public DNS**. It's an address ending in **`.code.run`**, for example:

```
https://p01--web--xxxx.code.run
```

Click it. The PH Grid Builder welcome screen should load over HTTPS. Northflank creates the security certificate automatically.

🎉 **Your simulator is live.** Share that link with anyone.

---

## Part 3 — Updating the live site

Northflank has **CI** and **CD** turned on by default for combined services. Every time you push to `main`, it rebuilds and redeploys automatically.

After you (or Claude) change the code, run these from the project folder:

```powershell
git add -A
```

```powershell
git commit -m "Describe what you changed"
```

```powershell
git push
```

Northflank detects the push, builds it, and your site updates in a few minutes. Refresh the page to see the change.

---

## Things to know

**Saved networks don't carry over.** Each website address keeps its own autosave, so the network you built on `localhost` won't appear on the `.code.run` site. To move it, use **⚙ Settings → Export JSON** locally, then **Import JSON** on the live site.

**Map tile providers.** The map loads imagery and terrain from free public services:

| Layer | Provider |
|---|---|
| Satellite imagery and labels | Esri World Imagery |
| Street map | OpenStreetMap |
| Topographic map | OpenTopoMap |
| 3D terrain | AWS Terrain Tiles (Mapzen) |

These are fine for a personal project or a demo shared with classmates and colleagues. For a widely used public site, OpenStreetMap's tile policy asks heavy users to use a commercial tile provider instead. Ask Claude to switch providers if you need that.

**Costs.** The Developer Sandbox is free but limited to one project. Making the service larger needs a paid plan. Check **https://northflank.com/pricing** for current details.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| **`git push` says `rejected … fetch first`** | The GitHub repository wasn't empty (a README or license was added). Run `git pull origin main --rebase --allow-unrelated-histories`, then `git push -u origin main`. |
| **`remote origin already exists`** | Run `git remote set-url origin https://github.com/YOUR-USERNAME/ph-grid-builder.git`, then push again. |
| **`Repository not found`** when pushing | Check the username and repository name in the URL, and that you signed in to the right GitHub account. |
| **Repository doesn't appear in Northflank** | Go back to Step 7 → **edit installation** on GitHub, and give Northflank access to `ph-grid-builder`. |
| **Build fails at `npm ci`** | Make sure `package-lock.json` was pushed. It must be on GitHub alongside `package.json`. |
| **Build fails at `npm run build`** | This step also typechecks the code. Open the build log, copy the red error lines and send them to Claude. |
| **Site shows "502" or won't load** | In **Configure → Networking**, check that port **80** exists with protocol **HTTP** and is **Public**. |
| **Site loads but the map is blank** | Check your internet connection and refresh. The map tiles come from outside services, not from Northflank. |
| **Changes don't appear after `git push`** | Check that **CI** and **CD** are on in the service header, then look at the **Builds** tab for a failed build. |

---

## What's in the repository

| File | Purpose |
|---|---|
| `src/` | The application source code (TypeScript + React + Three.js) |
| `package.json`, `package-lock.json` | Dependencies, locked to exact versions |
| `Dockerfile` | Instructions Northflank follows to build and run the site |
| `nginx.conf` | Web server settings: port 80, caching, `/healthz` check |
| `.gitignore` | Keeps `node_modules`, `dist` and local settings out of GitHub |
| `.dockerignore` | Keeps unnecessary files out of the Docker build |
| `Start PH Grid Builder.bat` | Run the app locally on Windows |
| `HOW TO RUN.md` | Running the app on your own PC |
| `DEPLOY.md` | This guide |
