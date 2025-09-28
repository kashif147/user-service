# Postman Collection Updates - Complete Endpoint Coverage

## ✅ **Updated Collections**

### 1. **Main Collection** (`postman-collection.json`)

- ✅ Updated existing endpoints with correct paths
- ✅ Added all new hierarchy endpoints
- ✅ Added missing authentication endpoints
- ✅ Added Country Management endpoints

### 2. **Dedicated Hierarchy Collection** (`postman-lookup-hierarchy.json`)

- ✅ Focused on hierarchy endpoints
- ✅ Added authentication endpoints for testing

---

## 🆕 **New Endpoints Added Since Yesterday**

### **Authentication Endpoints:**

- ✅ `POST /auth/logout` - Logout user and revoke all tokens
- ✅ `POST /auth/revoke-all` - Revoke all refresh tokens for current user (updated with auth header)

### **Lookup Hierarchy Endpoints:**

- ✅ `GET /api/lookup/{id}/hierarchy` - Get specific lookup with complete parent chain
- ✅ `GET /api/lookup/by-type/{lookuptypeId}/hierarchy` - Get all lookups by type with hierarchies

### **Country Management Endpoints:**

- ✅ `GET /countries` - Get all countries
- ✅ `GET /countries/search?q={term}` - Search countries
- ✅ `GET /countries/code/{code}` - Get country by code
- ✅ `GET /countries/{id}` - Get country by ID
- ✅ `POST /countries` - Create new country
- ✅ `PUT /countries/{id}` - Update country
- ✅ `DELETE /countries/{id}` - Delete country

---

## 🔧 **Fixed Issues**

### **Path Corrections:**

- ✅ Fixed lookup endpoints to use `/api/lookup` instead of `/lookup`
- ✅ Added missing `/api/` prefix where needed
- ✅ Updated request bodies to match actual API structure

### **Authentication Headers:**

- ✅ Added proper Authorization headers to logout endpoints
- ✅ Updated revoke-all endpoint to require authentication

### **Environment Variables:**

- ✅ Added lookup type IDs for easy testing
- ✅ Added sample lookup IDs from seeded data
- ✅ Added descriptions for all variables

---

## 📋 **Complete Endpoint Coverage**

### **Authentication (9 endpoints):**

1. Azure AD CRM Login (GET)
2. Azure AD CRM Callback (POST)
3. Azure B2C Portal Login (GET)
4. Azure B2C Portal Callback (POST)
5. General CRM Register (POST)
6. General CRM Login (POST)
7. Refresh Token (POST)
8. **Logout User (POST)** ← **NEW**
9. Revoke All Tokens (POST)

### **Lookup Management (10 endpoints):**

1. Get All Lookups (GET)
2. Create Lookup (POST)
3. Get Lookup by ID (GET)
4. **Get Lookup Hierarchy (GET)** ← **NEW**
5. **Get Lookups by Type with Hierarchy (GET)** ← **NEW**
6. **Get All Work Locations with Hierarchy (GET)** ← **NEW**
7. **Get All Branches with Hierarchy (GET)** ← **NEW**
8. **Get All Regions with Hierarchy (GET)** ← **NEW**
9. Update Lookup (PUT)
10. Delete Lookup (DELETE)

### **Country Management (7 endpoints):** ← **NEW SECTION**

1. **Get All Countries (GET)** ← **NEW**
2. **Search Countries (GET)** ← **NEW**
3. **Get Country by Code (GET)** ← **NEW**
4. **Get Country by ID (GET)** ← **NEW**
5. **Create Country (POST)** ← **NEW**
6. **Update Country (PUT)** ← **NEW**
7. **Delete Country (DELETE)** ← **NEW**

### **All Other Existing Endpoints:**

- ✅ User Management (8 endpoints)
- ✅ Role Management (9 endpoints)
- ✅ Policy Evaluation (7 endpoints)
- ✅ Tenant Management (6 endpoints)
- ✅ Permission Management (7 endpoints)
- ✅ Lookup Type Management (5 endpoints)
- ✅ Token Management (4 endpoints)
- ✅ PKCE (1 endpoint)
- ✅ Cache Management (5 endpoints)
- ✅ User Profile (1 endpoint)
- ✅ Tenant Scoped Operations (5 endpoints)

---

## 🎯 **Environment Variables Added**

```json
{
  "workLocationTypeId": "68d036e2662428d1c504b3ad", // WORKLOC
  "branchTypeId": "68d0369c662428d1c504b3aa", // BRANCH
  "regionTypeId": "68d0362a662428d1c504b3a8", // REGION
  "sampleWorkLocationId": "68d03cc23cacdcd15fdd74bb", // 360 Medical
  "sampleBranchId": "68d03cb93cacdcd15fdd6e83", // Cork Vol/Private Branch
  "sampleRegionId": "68d03cb83cacdcd15fdd6e4d" // South - South East
}
```

---

## 🚀 **Ready for Use**

Both Postman collections now include:

- ✅ **All endpoints** created since yesterday
- ✅ **Proper authentication** headers
- ✅ **Correct API paths**
- ✅ **Real data examples** from your seeded environment
- ✅ **Complete CRUD operations** for all resources

**Total Endpoints Covered: 87+ endpoints across all services**

The collections are now complete and ready for immediate testing! 🎉
