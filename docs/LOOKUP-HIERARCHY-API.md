# Lookup Hierarchy API Endpoints

This document describes the new lookup hierarchy endpoints that allow you to retrieve lookup data with their complete parent-child relationships.

## Endpoints Overview

### 1. Get Lookup Hierarchy

**GET** `/api/lookup/{id}/hierarchy`

Returns a specific lookup with its complete parent chain (ancestors).

### 2. Get Lookups by Type with Hierarchy

**GET** `/api/lookup/by-type/{lookuptypeId}/hierarchy`

Returns all lookups of a specific type with their complete parent chains.

---

## Endpoint Details

### 1. Get Lookup Hierarchy

**URL:** `GET /api/lookup/{id}/hierarchy`

**Description:** Given a lookup ID, returns the lookup details along with its complete parent hierarchy. For example, if you provide a work location ID, it will return the work location, its branch, and its region.

**Parameters:**

- `id` (path) - The lookup ID to retrieve hierarchy for

**Example Request:**

```bash
GET /api/lookup/507f1f77bcf86cd799439011/hierarchy
```

**Example Response:**

```json
{
  "requestedLookup": {
    "_id": "507f1f77bcf86cd799439011",
    "code": "WL_360MEDI",
    "lookupname": "360 Medical",
    "DisplayName": "360 Medical",
    "lookuptypeId": {
      "_id": "68d036e2662428d1c504b3ad",
      "code": "WORKLOC",
      "lookuptype": "workLocation",
      "displayname": "workLocation"
    },
    "isactive": true,
    "isdeleted": false
  },
  "hierarchy": [
    {
      "_id": "68d0362a662428d1c504b3a8",
      "code": "REG_SOUTHS",
      "lookupname": "South - South East",
      "DisplayName": "South - South East",
      "lookuptypeId": {
        "_id": "68d0362a662428d1c504b3a8",
        "code": "REGION",
        "lookuptype": "Region",
        "displayname": "Region"
      },
      "isactive": true,
      "isdeleted": false
    },
    {
      "_id": "507f1f77bcf86cd799439012",
      "code": "BR_CORKVOL",
      "lookupname": "Cork Vol/Private Branch",
      "DisplayName": "Cork Vol/Private Branch",
      "lookuptypeId": {
        "_id": "68d0369c662428d1c504b3aa",
        "code": "BRANCH",
        "lookuptype": "Branch",
        "displayname": "Branch"
      },
      "isactive": true,
      "isdeleted": false
    },
    {
      "_id": "507f1f77bcf86cd799439011",
      "code": "WL_360MEDI",
      "lookupname": "360 Medical",
      "DisplayName": "360 Medical",
      "lookuptypeId": {
        "_id": "68d036e2662428d1c504b3ad",
        "code": "WORKLOC",
        "lookuptype": "workLocation",
        "displayname": "workLocation"
      },
      "isactive": true,
      "isdeleted": false
    }
  ],
  "region": {
    "_id": "68d0362a662428d1c504b3a8",
    "code": "REG_SOUTHS",
    "lookupname": "South - South East",
    "DisplayName": "South - South East",
    "lookuptypeId": {
      "_id": "68d0362a662428d1c504b3a8",
      "code": "REGION",
      "lookuptype": "Region",
      "displayname": "Region"
    },
    "isactive": true,
    "isdeleted": false
  },
  "branch": {
    "_id": "507f1f77bcf86cd799439012",
    "code": "BR_CORKVOL",
    "lookupname": "Cork Vol/Private Branch",
    "DisplayName": "Cork Vol/Private Branch",
    "lookuptypeId": {
      "_id": "68d0369c662428d1c504b3aa",
      "code": "BRANCH",
      "lookuptype": "Branch",
      "displayname": "Branch"
    },
    "isactive": true,
    "isdeleted": false
  },
  "workLocation": {
    "_id": "507f1f77bcf86cd799439011",
    "code": "WL_360MEDI",
    "lookupname": "360 Medical",
    "DisplayName": "360 Medical",
    "lookuptypeId": {
      "_id": "68d036e2662428d1c504b3ad",
      "code": "WORKLOC",
      "lookuptype": "workLocation",
      "displayname": "workLocation"
    },
    "isactive": true,
    "isdeleted": false
  }
}
```

**Response Fields:**

- `requestedLookup` - The original lookup that was requested
- `hierarchy` - Array of all lookups in the hierarchy chain (ordered from top to bottom)
- `region` - Convenience field pointing to the region in the hierarchy
- `branch` - Convenience field pointing to the branch in the hierarchy
- `workLocation` - Convenience field pointing to the work location in the hierarchy

---

### 2. Get Lookups by Type with Hierarchy

**URL:** `GET /api/lookup/by-type/{lookuptypeId}/hierarchy`

**Description:** Returns all lookups of a specific type with their complete parent hierarchies. For example, if you provide the WORKLOC lookup type ID, it returns all work locations with their branches and regions.

**Parameters:**

- `lookuptypeId` (path) - The lookup type ID to filter by

**Example Request:**

```bash
GET /api/lookup/by-type/68d036e2662428d1c504b3ad/hierarchy
```

**Example Response:**

```json
{
  "lookuptype": {
    "_id": "68d036e2662428d1c504b3ad",
    "code": "WORKLOC",
    "lookuptype": "workLocation",
    "displayname": "workLocation"
  },
  "totalCount": 1473,
  "results": [
    {
      "lookup": {
        "_id": "507f1f77bcf86cd799439011",
        "code": "WL_360MEDI",
        "lookupname": "360 Medical",
        "DisplayName": "360 Medical",
        "lookuptypeId": {
          "_id": "68d036e2662428d1c504b3ad",
          "code": "WORKLOC",
          "lookuptype": "workLocation",
          "displayname": "workLocation"
        },
        "isactive": true,
        "isdeleted": false
      },
      "hierarchy": [
        {
          "_id": "68d0362a662428d1c504b3a8",
          "code": "REG_SOUTHS",
          "lookupname": "South - South East",
          "DisplayName": "South - South East",
          "lookuptypeId": {
            "_id": "68d0362a662428d1c504b3a8",
            "code": "REGION",
            "lookuptype": "Region",
            "displayname": "Region"
          },
          "isactive": true,
          "isdeleted": false
        },
        {
          "_id": "507f1f77bcf86cd799439012",
          "code": "BR_CORKVOL",
          "lookupname": "Cork Vol/Private Branch",
          "DisplayName": "Cork Vol/Private Branch",
          "lookuptypeId": {
            "_id": "68d0369c662428d1c504b3aa",
            "code": "BRANCH",
            "lookuptype": "Branch",
            "displayname": "Branch"
          },
          "isactive": true,
          "isdeleted": false
        },
        {
          "_id": "507f1f77bcf86cd799439011",
          "code": "WL_360MEDI",
          "lookupname": "360 Medical",
          "DisplayName": "360 Medical",
          "lookuptypeId": {
            "_id": "68d036e2662428d1c504b3ad",
            "code": "WORKLOC",
            "lookuptype": "workLocation",
            "displayname": "workLocation"
          },
          "isactive": true,
          "isdeleted": false
        }
      ],
      "region": {
        "_id": "68d0362a662428d1c504b3a8",
        "code": "REG_SOUTHS",
        "lookupname": "South - South East",
        "DisplayName": "South - South East",
        "lookuptypeId": {
          "_id": "68d0362a662428d1c504b3a8",
          "code": "REGION",
          "lookuptype": "Region",
          "displayname": "Region"
        },
        "isactive": true,
        "isdeleted": false
      },
      "branch": {
        "_id": "507f1f77bcf86cd799439012",
        "code": "BR_CORKVOL",
        "lookupname": "Cork Vol/Private Branch",
        "DisplayName": "Cork Vol/Private Branch",
        "lookuptypeId": {
          "_id": "68d0369c662428d1c504b3aa",
          "code": "BRANCH",
          "lookuptype": "Branch",
          "displayname": "Branch"
        },
        "isactive": true,
        "isdeleted": false
      },
      "workLocation": {
        "_id": "507f1f77bcf86cd799439011",
        "code": "WL_360MEDI",
        "lookupname": "360 Medical",
        "DisplayName": "360 Medical",
        "lookuptypeId": {
          "_id": "68d036e2662428d1c504b3ad",
          "code": "WORKLOC",
          "lookuptype": "workLocation",
          "displayname": "workLocation"
        },
        "isactive": true,
        "isdeleted": false
      }
    }
    // ... more results
  ]
}
```

**Response Fields:**

- `lookuptype` - Information about the lookup type that was queried
- `totalCount` - Total number of lookups found
- `results` - Array of lookup objects, each containing:
  - `lookup` - The original lookup details
  - `hierarchy` - Complete hierarchy chain for this lookup
  - `region`, `branch`, `workLocation` - Convenience fields

---

## Usage Examples

### Get hierarchy for a specific work location:

```bash
curl -X GET "https://your-api.com/api/lookup/WORK_LOCATION_ID/hierarchy" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Get all work locations with their hierarchies:

```bash
curl -X GET "https://your-api.com/api/lookup/by-type/WORKLOC_LOOKUPTYPE_ID/hierarchy" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Get all branches with their regions:

```bash
curl -X GET "https://your-api.com/api/lookup/by-type/BRANCH_LOOKUPTYPE_ID/hierarchy" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

---

## Error Responses

### 404 - Lookup Not Found

```json
{
  "status": "error",
  "message": "Lookup not found"
}
```

### 500 - Internal Server Error

```json
{
  "status": "error",
  "message": "Failed to retrieve lookup hierarchy"
}
```

---

## Notes

- Both endpoints require the same permissions as the standard lookup read operations
- The hierarchy is always ordered from top-level (region) to bottom-level (work location)
- Convenience fields (`region`, `branch`, `workLocation`) will be `null` if that type is not present in the hierarchy
- Only active, non-deleted lookups are returned
- The endpoints are optimized for performance but may take longer for large datasets
