# Environment Setup Guide - Fixed for Your Atlas Cluster

## ✅ Fixed MongoDB Connection

Your connection string has been updated to work with your Atlas cluster: `clusterprojectshell.tptnh8w.mongodb.net`

## 🔧 Environment Variables Setup

### Option 1: Individual Variables (RECOMMENDED)

```bash
# MongoDB Atlas Connection
MONGO_USER=your-mongodb-username
MONGO_PASS=your-mongodb-password
MONGO_DB=User-Service

# JWT Configuration
JWT_SECRET=your-super-secret-jwt-key-here
JWT_EXPIRY=24h

# Server Configuration
PORT=3000
NODE_ENV=staging
```

### Option 2: Full Connection String

```bash
# Complete MongoDB Atlas Connection
MONGO_URI=mongodb+srv://your-username:your-password@clusterprojectshell.tptnh8w.mongodb.net/User-Service/?retryWrites=true&w=majority&appName=ClusterProjectShell

# JWT Configuration
JWT_SECRET=your-super-secret-jwt-key-here
JWT_EXPIRY=24h

# Server Configuration
PORT=3000
NODE_ENV=staging
```

## 🚀 Quick Setup Commands

### For Individual Variables:

```bash
echo "MONGO_USER=your-username" > .env
echo "MONGO_PASS=your-password" >> .env
echo "MONGO_DB=User-Service" >> .env
echo "JWT_SECRET=your-super-secret-jwt-key" >> .env
echo "JWT_EXPIRY=24h" >> .env
echo "PORT=3000" >> .env
echo "NODE_ENV=staging" >> .env
```

### For Full Connection String:

```bash
echo "MONGO_URI=mongodb+srv://your-username:your-password@clusterprojectshell.tptnh8w.mongodb.net/User-Service/?retryWrites=true&w=majority&appName=ClusterProjectShell" > .env
echo "JWT_SECRET=your-super-secret-jwt-key" >> .env
echo "JWT_EXPIRY=24h" >> .env
echo "PORT=3000" >> .env
echo "NODE_ENV=staging" >> .env
```

## 📝 Updated Package.json Scripts

Your package.json now includes these convenient scripts:

```bash
# Development
npm run dev                    # Start with nodemon
npm start                     # Start normally

# Staging
npm run dev:staging           # Start staging with nodemon
npm run start:staging         # Start staging normally

# RBAC Management
npm run setup-rbac           # Initialize all roles
npm run assign-roles:dry-run # Preview role assignments
npm run assign-roles         # Assign default roles
npm run assign-roles:force   # Force assign roles
npm run remove-roles         # Preview role removal
npm run remove-roles:force   # Force remove roles
npm run test-roles           # Test role assignments
npm run test-reo             # Test REO role specifically
```

## 🔧 What Was Fixed

1. **Database Connection**: Updated all scripts to use your Atlas cluster
2. **Environment Variables**: Support for both individual vars and full connection string
3. **Fallback Logic**: If `MONGO_URI` is not set, it builds the connection string from individual variables
4. **Database Name**: Uses `User-Service` as your database name

## 🚀 Your Final Commands

```bash
# 1. Set up your .env file with MongoDB credentials
# 2. Initialize roles
npm run setup-rbac

# 3. Preview role assignments
npm run assign-roles:dry-run

# 4. Execute role assignments
npm run assign-roles
```

## ⚠️ Important Notes

- Replace `your-username` and `your-password` with your actual MongoDB Atlas credentials
- Make sure your MongoDB user has read/write permissions
- Ensure your IP is whitelisted in MongoDB Atlas
- If password contains special characters, URL encode them (`@` becomes `%40`)

## 🧪 Test Connection

```bash
# Test if everything works
npm run setup-rbac
```

This should now connect successfully to your Atlas cluster!
