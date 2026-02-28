# Duplicate User Detection - Azure B2C Validation

## Overview

The `/api/user/validate` endpoint now checks for duplicate users across **three fields**:
1. **Email** (always checked)
2. **Mobile Phone** (checked if provided)
3. **Member Number** (checked if provided)

This prevents users from creating multiple accounts with the same contact information.

---

## How It Works

### Database Query

The endpoint uses MongoDB's `$or` operator to find existing users matching ANY of the provided fields:

```javascript
const duplicateChecks = [];

// Always check email (required)
duplicateChecks.push({ userEmail: email });

// Check mobile phone if provided
if (mobilephone) {
  duplicateChecks.push({ userMobilePhone: mobilephone });
}

// Check member number if provided
if (memberno) {
  duplicateChecks.push({ userMemberNumber: memberno });
}

// Find user matching ANY of these fields
const user = await User.findOne({
  $or: duplicateChecks,
  isActive: true
});
```

### Example Query

If user provides:
- Email: `john@example.com`
- Mobile: `+1234567890`
- Member: `MEM-001`

Query executed:
```javascript
User.findOne({
  $or: [
    { userEmail: "john@example.com" },
    { userMobilePhone: "+1234567890" },
    { userMemberNumber: "MEM-001" }
  ],
  isActive: true
})
```

---

## Response Behavior

### Scenario 1: No Match (New User)
**Input:**
- All fields are unique (not in database)

**Response:**
```json
HTTP 200 OK
{
  "version": "1.0.0",
  "action": "Continue",
  "email": "newuser@example.com",
  "tenantId": "default-tenant-id"
}
```

✅ **Azure B2C proceeds with registration**

---

### Scenario 2: Duplicate Email
**Input:**
- Email: `existing@example.com` (exists in DB)
- Mobile: `+9999999999` (unique)
- Member: `MEM-NEW` (unique)

**Response:**
```json
HTTP 200 OK
{
  "version": "1.0.0",
  "action": "ShowBlockPage",
  "userMessage": "An account with this email address already exists. Please sign in instead or use a different email address."
}
```

🚫 **User is blocked from signup**

---

### Scenario 3: Duplicate Mobile Phone
**Input:**
- Email: `newemail@example.com` (unique)
- Mobile: `+1234567890` (exists in DB)
- Member: `MEM-NEW` (unique)

**Response:**
```json
HTTP 200 OK
{
  "version": "1.0.0",
  "action": "ShowBlockPage",
  "userMessage": "An account with this mobile phone number already exists. Please sign in instead or use a different mobile phone number."
}
```

🚫 **User is blocked from signup**

---

### Scenario 4: Duplicate Member Number
**Input:**
- Email: `newemail@example.com` (unique)
- Mobile: `+9999999999` (unique)
- Member: `MEM-123` (exists in DB)

**Response:**
```json
HTTP 200 OK
{
  "version": "1.0.0",
  "action": "ShowBlockPage",
  "userMessage": "An account with this member number already exists. Please sign in instead or use a different member number."
}
```

🚫 **User is blocked from signup**

---

### Scenario 5: Multiple Duplicate Fields
**Input:**
- Email: `existing@example.com` (exists)
- Mobile: `+1234567890` (exists)
- Member: `MEM-NEW` (unique)

**Response:**
```json
HTTP 200 OK
{
  "version": "1.0.0",
  "action": "ShowBlockPage",
  "userMessage": "An account with this email address and mobile phone number already exists. Please sign in instead."
}
```

🚫 **User is blocked, shown which fields conflict**

---

### Scenario 6: All Three Fields Duplicate
**Input:**
- Email: `existing@example.com` (exists)
- Mobile: `+1234567890` (exists)
- Member: `MEM-123` (exists)

**Response:**
```json
HTTP 200 OK
{
  "version": "1.0.0",
  "action": "ShowBlockPage",
  "userMessage": "An account with this email address and mobile phone number and member number already exists. Please sign in instead."
}
```

🚫 **User is blocked with full details**

---

## User Messages

The error message is **dynamic** based on which field(s) caused the duplicate:

| Duplicate Fields | User Message |
|------------------|--------------|
| Email only | "An account with this **email address** already exists..." |
| Mobile only | "An account with this **mobile phone number** already exists..." |
| Member only | "An account with this **member number** already exists..." |
| Email + Mobile | "An account with this **email address and mobile phone number** already exists..." |
| Email + Member | "An account with this **email address and member number** already exists..." |
| Mobile + Member | "An account with this **mobile phone number and member number** already exists..." |
| All three | "An account with this **email address and mobile phone number and member number** already exists..." |

---

## Important Notes

### 1. Optional Fields
- **Mobile phone** and **member number** are optional
- Only checked if user provides them
- If not provided, no duplicate check for that field

### 2. Database Performance
- Query uses MongoDB indexes for fast lookup
- 3-second timeout to prevent hanging
- Uses `lean()` for faster queries

### 3. Field Matching Logic
```javascript
// Determines which fields matched
const duplicateFields = [];

if (user.userEmail === email) {
  duplicateFields.push("email address");
}

if (mobilephone && user.userMobilePhone === mobilephone) {
  duplicateFields.push("mobile phone number");
}

if (memberno && user.userMemberNumber === memberno) {
  duplicateFields.push("member number");
}
```

### 4. Non-Signup Steps
If user is signing in (not signup), duplicate checking still happens but **doesn't block**:
- Duplicate found + signup step → **Block**
- Duplicate found + signin step → **Continue** (allow signin)

---

## Testing

### Manual Test
```bash
# Test duplicate email
curl -X POST http://localhost:3000/api/user/validate \
  -H "Content-Type: application/json" \
  -d '{
    "email": "existing@example.com",
    "mobilephone": "+9999999999",
    "memberno": "MEM-UNIQUE",
    "step": "PostAttributeCollection"
  }'
```

### Comprehensive Test Script
```bash
chmod +x test-b2c-duplicate-checks.sh
./test-b2c-duplicate-checks.sh local
```

Tests all scenarios:
- ✅ New user (all unique)
- 🚫 Duplicate email
- 🚫 Duplicate mobile
- 🚫 Duplicate member number
- 🚫 Multiple duplicates

---

## Database Schema

User model must have these fields:

```javascript
{
  userEmail: String,          // Required, used for duplicate check
  userMobilePhone: String,    // Optional, checked if provided
  userMemberNumber: String,   // Optional, checked if provided
  isActive: Boolean           // Only check active users
}
```

**Recommended Indexes:**
```javascript
// For fast duplicate checking
db.users.createIndex({ userEmail: 1 })
db.users.createIndex({ userMobilePhone: 1 })
db.users.createIndex({ userMemberNumber: 1 })
db.users.createIndex({ isActive: 1 })

// Compound index for the query
db.users.createIndex({ 
  userEmail: 1, 
  userMobilePhone: 1, 
  userMemberNumber: 1, 
  isActive: 1 
})
```

---

## Benefits

### 1. Prevents Duplicate Accounts
- Users can't register multiple times with same email
- Users can't use same mobile number for multiple accounts
- Users can't reuse member numbers

### 2. User-Friendly Messages
- Clear indication of which field caused the issue
- Suggests signing in if account exists
- Mentions all conflicting fields

### 3. Flexible Validation
- Only checks fields that are provided
- Works with optional fields
- Handles edge cases (missing mobile/member)

### 4. Performance Optimized
- Single database query for all checks
- Uses MongoDB $or operator efficiently
- 3-second timeout prevents hanging
- Lean queries for faster response

---

## Migration Notes

If upgrading from previous version:

### Before (Old Behavior)
- ✅ Checked email only
- ❌ Didn't check mobile phone
- ❌ Didn't check member number

### After (New Behavior)
- ✅ Checks email (always)
- ✅ Checks mobile phone (if provided)
- ✅ Checks member number (if provided)
- ✅ User-friendly messages indicating which field conflicts

### Impact
- Users with duplicate mobile numbers will now be blocked
- Users with duplicate member numbers will now be blocked
- More robust duplicate prevention

---

## Troubleshooting

### Issue: False Positives
**Problem:** Blocking users who should be allowed

**Solution:** Check database for:
- Inactive users (`isActive: false`) - these are excluded
- Null/empty values matching user input
- Case sensitivity issues

### Issue: Slow Performance
**Problem:** Query takes > 3 seconds

**Solution:**
- Add database indexes (see Database Schema section)
- Check database connection
- Monitor query performance

### Issue: Wrong Error Message
**Problem:** Message doesn't match actual duplicate

**Solution:** Check field matching logic:
- Ensure exact matches (case-sensitive)
- Check for null/undefined handling
- Verify database field names match model

---

## Summary

The endpoint now provides **comprehensive duplicate detection** across email, mobile phone, and member number. This prevents:

- ✅ Multiple accounts with same email
- ✅ Multiple accounts with same mobile phone
- ✅ Multiple accounts with same member number
- ✅ Confusing duplicate account scenarios

Users get **clear, specific messages** about why they're blocked and which field(s) already exist.
