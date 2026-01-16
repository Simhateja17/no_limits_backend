# Deployment Guide

## Backend Deployment on Render

### Prerequisites
- GitHub repository with your backend code
- Supabase database already set up

### Step 1: Create Web Service on Render

1. Go to [Render Dashboard](https://dashboard.render.com/)
2. Click **"New +"** → **"Web Service"**
3. Connect your GitHub repository
4. Select the repository with your backend code

### Step 2: Configure Build Settings

**Basic Settings:**
- **Name**: `no-limits-backend` (or your preferred name)
- **Region**: Choose closest to your users
- **Branch**: `main` (or your production branch)
- **Root Directory**: `backend`
- **Runtime**: `Node`
- **Build Command**: `npm install && npx prisma generate && npm run build`
- **Start Command**: `npm start`

**Instance Type:**
- Free tier or paid based on your needs

### Step 3: Environment Variables

Add these environment variables in Render:

```
NODE_ENV=production
PORT=3001
DATABASE_URL=postgresql://postgres:[YOUR-PASSWORD]@db.ydzikxftogcggykkoetu.supabase.co:5432/postgres
SUPABASE_URL=https://ydzikxftogcggykkoetu.supabase.co
SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlkemlreGZ0b2djZ2d5a2tvZXR1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjYwMjkxMjcsImV4cCI6MjA4MTYwNTEyN30.HohFPXMBQeKN29pQ9woR-yce0G3fHhRqSdPYXE2hqfs
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlkemlreGZ0b2djZ2d5a2tvZXR1Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjAyOTEyNywiZXhwIjoyMDgxNjA1MTI3fQ.y6pbt-v9o8LjkIrsJmPVy-WFl2JlQ4bGy32zDhxR82Q
FRONTEND_URL=https://no-limits-seven.vercel.app
JWT_SECRET=[GENERATE_STRONG_SECRET]
JWT_EXPIRES_IN=7d
JWT_REFRESH_SECRET=[GENERATE_DIFFERENT_STRONG_SECRET]
JWT_REFRESH_EXPIRES_IN=30d
```

**To generate strong JWT secrets**, run this in your terminal:
```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

### Step 4: Deploy

1. Click **"Create Web Service"**
2. Render will automatically build and deploy
3. Once deployed, you'll get a URL like: `https://no-limits-backend.onrender.com`

### Step 5: Test the Deployment

Visit: `https://your-backend-url.onrender.com/`

You should see: `{"message": "API is running"}`

---

## Frontend Configuration on Vercel

### Update Environment Variables in Vercel

1. Go to your Vercel project: https://vercel.com/dashboard
2. Select your **no-limits-seven** project
3. Go to **Settings** → **Environment Variables**
4. Add this variable:

**Variable Name**: `NEXT_PUBLIC_API_URL`
**Value**: `https://your-backend-url.onrender.com/api`

(Replace `your-backend-url` with your actual Render URL)

5. Click **Save**
6. Go to **Deployments** tab
7. Click the three dots on the latest deployment → **Redeploy**

---

## Testing the Connection

### Test Login
1. Visit: https://no-limits-seven.vercel.app/
2. Try logging in with test credentials:
   - Email: `superadmin@nolimits.com`
   - Password: `password123`

### Check Network Tab
1. Open browser DevTools (F12)
2. Go to Network tab
3. Try logging in
4. You should see requests going to your Render backend URL

---

## Troubleshooting

### CORS Issues
If you see CORS errors in the browser console:
1. Check that `FRONTEND_URL` in Render includes your Vercel URL
2. Make sure there's no trailing slash in the URL
3. Redeploy the backend after updating environment variables

### Database Connection Issues
- Verify `DATABASE_URL` is correct in Render
- Make sure Supabase database is accessible
- Check Supabase logs for connection attempts

### 502 Bad Gateway
- Backend is still starting up (wait 1-2 minutes)
- Check Render logs for errors
- Verify build command completed successfully

### Environment Variables Not Working
- After adding/changing env vars in Render, you must redeploy
- Go to your service → Manual Deploy → Deploy latest commit

---

## Important Notes

1. **Free Tier Limitations**: 
   - Render free tier spins down after 15 minutes of inactivity
   - First request after spin-down takes ~30 seconds to wake up
   - Consider upgrading for production use

2. **Database Migrations**:
   - Schema is already pushed to Supabase
   - No need to run migrations on Render

3. **Security**:
   - Never commit `.env` files to Git
   - Use strong JWT secrets in production
   - Regularly rotate secrets

4. **Monitoring**:
   - Check Render logs regularly
   - Monitor Supabase database performance
   - Set up error tracking (e.g., Sentry)
