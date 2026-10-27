/**
 * Lookup Cache Service
 *
 * Provides Redis caching for lookup and lookup type data
 * with fallback to database queries when Redis is unavailable
 *
 * Phase A / A11: every lookup cache entry is TENANT-KEYED and VERSIONED:
 *   lookup:v2:<tenantId>:all | lookup:v2:<tenantId>:id:<lookupId>
 *   lookuptype:v2:<tenantId>:all | :id:<lookuptypeId> | :code:<CODE>
 *   hierarchy:v2:<tenantId>:<lookupId>
 *   lookuptype-hierarchy:v2:<tenantId>:type:<lookuptypeId>
 * Lookup rows are still GLOBAL today (Phase D makes them tenant-owned), so the database query is
 * unchanged and identical ids may sit under several tenants' keys - but an entry is only ever read
 * back under the trusted tenant that resolved it. No trusted tenant (missing, placeholder or
 * malformed) -> TENANT_REQUIRED, the DB is not queried. Over HTTP the requireTrustedTenant route
 * guard answers 400 first; the throw is the backstop for any other caller. Writes invalidate every tenant's entries (the data is shared until Phase D).
 * The pre-Phase-A global keys (LEGACY_KEY_PATTERNS) are unreachable (v2 prefix) and purged from Redis
 * at startup and by clearAllCaches. Countries are TENANT-OWNED reference data: stored and cached
 * globally only until Phase E clones them per tenant, when their keys gain the tenant dimension too.
 */

const PolicyCache = require("./policyCache");
const { AppError } = require("../errors/AppError");

const LOOKUP_CACHE_VERSION = "v2";

// Exact pre-Phase-A key shapes (prefix + key). None of them can match a v2 key.
const LEGACY_KEY_PATTERNS = [
  "lookup:all",
  "lookup:id:*",
  "lookuptype:all",
  "lookuptype:id:*",
  "hierarchy:hierarchy:*",
  "lookuptype-hierarchy:type:*",
];

const PLACEHOLDER_TENANTS = ["default", "unknown", "system", "null", "undefined"];

/** Trusted tenant for a cache key, or null (no key) when it is missing or a placeholder. */
const cacheTenant = (tenantId) => {
  const t = tenantId == null ? "" : String(tenantId).trim();
  if (!t || PLACEHOLDER_TENANTS.includes(t.toLowerCase()) || /[\s:*?[\]]/.test(t)) return null;
  return t;
};

class LookupCacheService {
  constructor() {
    const ttl = parseInt(process.env.LOOKUP_CACHE_TTL) || 600; // 10 minutes default
    const enabled = process.env.REDIS_ENABLED !== "false";

    // Initialize cache for lookups
    this.lookupCache = new PolicyCache({
      enabled,
      ttl,
      prefix: `lookup:${LOOKUP_CACHE_VERSION}:`,
    });

    // Initialize cache for lookup types
    this.lookupTypeCache = new PolicyCache({
      enabled,
      ttl,
      prefix: `lookuptype:${LOOKUP_CACHE_VERSION}:`,
    });

    // Initialize cache for countries (tenant-owned; global storage and key only until the Phase E clone)
    this.countryCache = new PolicyCache({
      enabled,
      ttl,
      prefix: "country:",
    });

    // Initialize cache for lookup hierarchies
    this.hierarchyCache = new PolicyCache({
      enabled,
      ttl,
      prefix: `hierarchy:${LOOKUP_CACHE_VERSION}:`,
    });

    // Initialize cache for lookups by type with hierarchy
    this.lookupTypeHierarchyCache = new PolicyCache({
      enabled,
      ttl,
      prefix: `lookuptype-hierarchy:${LOOKUP_CACHE_VERSION}:`,
    });

    // Initialize caches on startup
    this.initialize();
  }

  async initialize() {
    try {
      await this.lookupCache.initialize();
      await this.lookupTypeCache.initialize();
      await this.countryCache.initialize();
      await this.hierarchyCache.initialize();
      await this.lookupTypeHierarchyCache.initialize();
      console.log("✅ Lookup cache services initialized");
      await this.purgeLegacyKeys();
    } catch (error) {
      console.error("❌ Failed to initialize lookup cache services:", error);
    }
  }

  /** Full cache key (without the cache prefix) for a tenant, or null when there is no trusted tenant. */
  keyFor(tenantId, key) {
    const t = cacheTenant(tenantId);
    return t ? `${t}:${key}` : null;
  }

  /**
   * Shared read-through: tenant-keyed get -> DB on miss -> set.
   * No trusted tenant: throws TENANT_REQUIRED; no key is read or written and the DB is not queried.
   */
  async readThrough(cache, label, tenantId, key, dbQuery, { cacheEmpty = false } = {}) {
    const cacheKey = this.keyFor(tenantId, key);
    if (!cacheKey) {
      // Fail closed: never read the shared rows for a request without a trusted tenant.
      throw new AppError("Tenant context required", 400, "TENANT_REQUIRED");
    }

    try {
      // Try to get from cache first
      const cached = await cache.get(cacheKey);
      if (cached) {
        console.log(`📦 Cache hit: ${label}`);
        return cached;
      }

      // Cache miss - fetch from database
      console.log(`💾 Cache miss: ${label} - fetching from DB`);
      const data = await dbQuery();

      // Cache the result (only if found, unless the caller caches empty results)
      if ((data || cacheEmpty) && cache.enabled) {
        await cache.set(cacheKey, data);
      }

      return data;
    } catch (error) {
      console.error(`Lookup cache error (${label}):`, error);
      // Fallback to database
      return await dbQuery();
    }
  }

  // ===== LOOKUP CACHE METHODS =====

  /**
   * Get all lookups from cache or database
   * @param {string} tenantId - Trusted tenant (cache namespace)
   * @param {Function} dbQuery - Database query function
   * @returns {Promise<Array>} Lookup data
   */
  async getAllLookups(tenantId, dbQuery) {
    return this.readThrough(this.lookupCache, "getAllLookups", tenantId, "all", dbQuery, {
      cacheEmpty: true,
    });
  }

  /**
   * Get single lookup by ID from cache or database
   * @param {string} tenantId - Trusted tenant (cache namespace)
   * @param {string} id - Lookup ID
   * @param {Function} dbQuery - Database query function
   * @returns {Promise<Object|null>} Lookup data
   */
  async getLookupById(tenantId, id, dbQuery) {
    return this.readThrough(this.lookupCache, `getLookupById(${id})`, tenantId, `id:${id}`, dbQuery);
  }

  /**
   * Invalidate lookup cache. Lookups are shared by every tenant until Phase D, so a change
   * invalidates every tenant's entries (the optional id is kept for call-site compatibility).
   */
  async invalidateLookupCache(id = null) {
    try {
      await this.lookupCache.clear();
      console.log(`🗑️ Invalidated lookup cache (all tenants)${id ? ` for ID: ${id}` : ""}`);
    } catch (error) {
      console.error("Lookup cache invalidation error:", error);
    }
  }

  /**
   * Get lookup hierarchy from cache or database
   * @param {string} tenantId - Trusted tenant (cache namespace)
   * @param {string} id - Lookup ID
   * @param {Function} dbQuery - Database query function
   * @returns {Promise<Object|null>} Lookup hierarchy data
   */
  async getLookupHierarchy(tenantId, id, dbQuery) {
    return this.readThrough(this.hierarchyCache, `getLookupHierarchy(${id})`, tenantId, id, dbQuery);
  }

  /**
   * Get lookups by type with hierarchy from cache or database
   * @param {string} tenantId - Trusted tenant (cache namespace)
   * @param {string} lookuptypeId - Lookup type ID
   * @param {Function} dbQuery - Database query function
   * @returns {Promise<Object|null>} Lookups by type with hierarchy data
   */
  async getLookupsByTypeWithHierarchy(tenantId, lookuptypeId, dbQuery) {
    return this.readThrough(
      this.lookupTypeHierarchyCache,
      `getLookupsByTypeWithHierarchy(${lookuptypeId})`,
      tenantId,
      `type:${lookuptypeId}`,
      dbQuery
    );
  }

  /**
   * Invalidate hierarchy caches. A lookup's officer/name/parent can appear inside other lookups'
   * hierarchies and in every by-type result, so any change clears both hierarchy caches for every
   * tenant (the optional ids are kept for call-site compatibility).
   */
  async invalidateHierarchyCache(id = null, lookuptypeId = null) {
    try {
      await this.hierarchyCache.clear();
      await this.lookupTypeHierarchyCache.clear();
      console.log(
        `🗑️ Invalidated hierarchy caches (all tenants)${id ? ` lookup ${id}` : ""}${
          lookuptypeId ? ` type ${lookuptypeId}` : ""
        }`
      );
    } catch (error) {
      console.error("Hierarchy cache invalidation error:", error);
    }
  }

  // ===== LOOKUP TYPE CACHE METHODS =====

  /**
   * Get all lookup types from cache or database
   * @param {string} tenantId - Trusted tenant (cache namespace)
   * @param {Function} dbQuery - Database query function
   * @returns {Promise<Array>} Lookup type data
   */
  async getAllLookupTypes(tenantId, dbQuery) {
    return this.readThrough(this.lookupTypeCache, "getAllLookupTypes", tenantId, "all", dbQuery, {
      cacheEmpty: true,
    });
  }

  /**
   * Get single lookup type by ID from cache or database
   * @param {string} tenantId - Trusted tenant (cache namespace)
   * @param {string} id - Lookup type ID
   * @param {Function} dbQuery - Database query function
   * @returns {Promise<Object|null>} Lookup type data
   */
  async getLookupTypeById(tenantId, id, dbQuery) {
    return this.readThrough(this.lookupTypeCache, `getLookupTypeById(${id})`, tenantId, `id:${id}`, dbQuery);
  }

  /**
   * Resolve a lookup type's stable code to its id (Phase A / A10). Misses are not cached.
   * @param {string} tenantId - Trusted tenant (cache namespace; Phase D also filters the query by it)
   * @param {string} code - Normalised (upper-case) lookup type code
   * @param {Function} dbQuery - resolves to the id string, or null when the code is unknown
   * @returns {Promise<string|null>} Lookup type id
   */
  async getLookupTypeIdByCode(tenantId, code, dbQuery) {
    return this.readThrough(this.lookupTypeCache, `getLookupTypeIdByCode(${code})`, tenantId, `code:${code}`, dbQuery);
  }

  /**
   * Invalidate lookup type cache (all, by-id and by-code entries) for every tenant - a type's code
   * can change on update. The optional id is kept for call-site compatibility.
   */
  async invalidateLookupTypeCache(id = null) {
    try {
      await this.lookupTypeCache.clear();
      console.log(`🗑️ Invalidated lookup type cache (all tenants)${id ? ` for ID: ${id}` : ""}`);
    } catch (error) {
      console.error("Lookup type cache invalidation error:", error);
    }
  }

  // ===== COUNTRY CACHE METHODS =====

  /**
   * Get all countries from cache or database
   * @param {Function} dbQuery - Database query function
   * @returns {Promise<Array>} Country data
   */
  async getAllCountries(dbQuery) {
    const cacheKey = "all";

    try {
      // Try to get from cache first
      const cached = await this.countryCache.get(cacheKey);
      if (cached) {
        console.log("📦 Cache hit: getAllCountries");
        return cached;
      }

      // Cache miss - fetch from database
      console.log("💾 Cache miss: getAllCountries - fetching from DB");
      const data = await dbQuery();

      // Cache the result
      if (this.countryCache.enabled) {
        await this.countryCache.set(cacheKey, data);
      }

      return data;
    } catch (error) {
      console.error("Country cache error:", error);
      // Fallback to database
      return await dbQuery();
    }
  }

  /**
   * Get single country by ID from cache or database
   * @param {string} id - Country ID
   * @param {Function} dbQuery - Database query function
   * @returns {Promise<Object|null>} Country data
   */
  async getCountryById(id, dbQuery) {
    const cacheKey = `id:${id}`;

    try {
      // Try to get from cache first
      const cached = await this.countryCache.get(cacheKey);
      if (cached) {
        console.log(`📦 Cache hit: getCountryById(${id})`);
        return cached;
      }

      // Cache miss - fetch from database
      console.log(`💾 Cache miss: getCountryById(${id}) - fetching from DB`);
      const data = await dbQuery();

      // Cache the result (only if found)
      if (data && this.countryCache.enabled) {
        await this.countryCache.set(cacheKey, data);
      }

      return data;
    } catch (error) {
      console.error("Country cache error:", error);
      // Fallback to database
      return await dbQuery();
    }
  }

  /**
   * Get country by code from cache or database
   * @param {string} code - Country code (ISO2)
   * @param {Function} dbQuery - Database query function
   * @returns {Promise<Object|null>} Country data
   */
  async getCountryByCode(code, dbQuery) {
    const cacheKey = `code:${code}`;

    try {
      // Try to get from cache first
      const cached = await this.countryCache.get(cacheKey);
      if (cached) {
        console.log(`📦 Cache hit: getCountryByCode(${code})`);
        return cached;
      }

      // Cache miss - fetch from database
      console.log(
        `💾 Cache miss: getCountryByCode(${code}) - fetching from DB`
      );
      const data = await dbQuery();

      // Cache the result (only if found)
      if (data && this.countryCache.enabled) {
        await this.countryCache.set(cacheKey, data);
      }

      return data;
    } catch (error) {
      console.error("Country cache error:", error);
      // Fallback to database
      return await dbQuery();
    }
  }

  /**
   * Invalidate country cache
   * @param {string} id - Optional specific country ID
   * @param {string} code - Optional specific country code
   */
  async invalidateCountryCache(id = null, code = null) {
    if (!this.countryCache.enabled) return;

    try {
      if (id) {
        // Invalidate specific country by ID
        await this.countryCache.del(`id:${id}`);
        console.log(`🗑️ Invalidated country cache for ID: ${id}`);
      }
      if (code) {
        // Invalidate specific country by code
        await this.countryCache.del(`code:${code}`);
        console.log(`🗑️ Invalidated country cache for code: ${code}`);
      }
      if (!id && !code) {
        // Invalidate all country cache
        await this.countryCache.del("all");
        console.log("🗑️ Invalidated all country cache");
      }
    } catch (error) {
      console.error("Country cache invalidation error:", error);
    }
  }

  // ===== CACHE MANAGEMENT =====

  /**
   * Delete the pre-Phase-A global lookup keys from Redis (exact legacy shapes only - never a v2 key,
   * never another cache's data). Without Redis there is nothing to purge: the old process' in-memory
   * entries ended with it, and the v2 prefix makes the old keys unreachable anyway.
   * @returns {Promise<{redis: boolean, removed: number}>}
   */
  async purgeLegacyKeys() {
    const redis = this.lookupCache.redis;
    if (!this.lookupCache.enabled || !redis) {
      return { redis: false, removed: 0 };
    }
    let removed = 0;
    try {
      for (const pattern of LEGACY_KEY_PATTERNS) {
        const keys = await redis.keys(pattern);
        if (keys.length > 0) {
          removed += await redis.del(keys);
        }
      }
      console.log(`🧹 Purged ${removed} legacy (pre-v2) lookup cache keys`);
    } catch (error) {
      console.error("Legacy lookup cache purge error:", error.message);
    }
    return { redis: true, removed };
  }

  /**
   * Clear all lookup-related caches
   */
  async clearAllCaches() {
    try {
      await this.lookupCache.clear();
      await this.lookupTypeCache.clear();
      await this.countryCache.clear();
      await this.hierarchyCache.clear();
      await this.lookupTypeHierarchyCache.clear();
      await this.purgeLegacyKeys();
      console.log("🧹 Cleared all lookup caches");
    } catch (error) {
      console.error("Error clearing lookup caches:", error);
    }
  }

  /**
   * Get cache statistics
   */
  async getCacheStats() {
    try {
      const lookupStats = await this.lookupCache.getStats();
      const lookupTypeStats = await this.lookupTypeCache.getStats();
      const countryStats = await this.countryCache.getStats();
      const hierarchyStats = await this.hierarchyCache.getStats();
      const lookupTypeHierarchyStats =
        await this.lookupTypeHierarchyCache.getStats();

      return {
        lookup: lookupStats,
        lookupType: lookupTypeStats,
        country: countryStats,
        hierarchy: hierarchyStats,
        lookupTypeHierarchy: lookupTypeHierarchyStats,
        enabled: this.lookupCache.enabled,
        version: LOOKUP_CACHE_VERSION,
      };
    } catch (error) {
      console.error("Error getting cache stats:", error);
      return { error: error.message };
    }
  }
}

// Export singleton instance
module.exports = new LookupCacheService();
module.exports.LookupCacheService = LookupCacheService;
module.exports.LEGACY_KEY_PATTERNS = LEGACY_KEY_PATTERNS;
module.exports.LOOKUP_CACHE_VERSION = LOOKUP_CACHE_VERSION;
module.exports.cacheTenant = cacheTenant;
