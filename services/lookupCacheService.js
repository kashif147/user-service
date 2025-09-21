/**
 * Lookup Cache Service
 *
 * Provides Redis caching for lookup and lookup type data
 * with fallback to database queries when Redis is unavailable
 */

const PolicyCache = require("./policyCache");

class LookupCacheService {
  constructor() {
    // Initialize cache for lookups
    this.lookupCache = new PolicyCache({
      enabled: process.env.REDIS_ENABLED !== "false",
      ttl: parseInt(process.env.LOOKUP_CACHE_TTL) || 600, // 10 minutes default
      prefix: "lookup:",
    });

    // Initialize cache for lookup types
    this.lookupTypeCache = new PolicyCache({
      enabled: process.env.REDIS_ENABLED !== "false",
      ttl: parseInt(process.env.LOOKUP_CACHE_TTL) || 600, // 10 minutes default
      prefix: "lookuptype:",
    });

    // Initialize cache for countries
    this.countryCache = new PolicyCache({
      enabled: process.env.REDIS_ENABLED !== "false",
      ttl: parseInt(process.env.LOOKUP_CACHE_TTL) || 600, // 10 minutes default
      prefix: "country:",
    });

    // Initialize cache for lookup hierarchies
    this.hierarchyCache = new PolicyCache({
      enabled: process.env.REDIS_ENABLED !== "false",
      ttl: parseInt(process.env.LOOKUP_CACHE_TTL) || 600, // 10 minutes default
      prefix: "hierarchy:",
    });

    // Initialize cache for lookups by type with hierarchy
    this.lookupTypeHierarchyCache = new PolicyCache({
      enabled: process.env.REDIS_ENABLED !== "false",
      ttl: parseInt(process.env.LOOKUP_CACHE_TTL) || 600, // 10 minutes default
      prefix: "lookuptype-hierarchy:",
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
    } catch (error) {
      console.error("❌ Failed to initialize lookup cache services:", error);
    }
  }

  // ===== LOOKUP CACHE METHODS =====

  /**
   * Get all lookups from cache or database
   * @param {Function} dbQuery - Database query function
   * @returns {Promise<Array>} Lookup data
   */
  async getAllLookups(dbQuery) {
    const cacheKey = "all";

    try {
      // Try to get from cache first
      const cached = await this.lookupCache.get(cacheKey);
      if (cached) {
        console.log("📦 Cache hit: getAllLookups");
        return cached;
      }

      // Cache miss - fetch from database
      console.log("💾 Cache miss: getAllLookups - fetching from DB");
      const data = await dbQuery();

      // Cache the result
      if (this.lookupCache.enabled) {
        await this.lookupCache.set(cacheKey, data);
      }

      return data;
    } catch (error) {
      console.error("Lookup cache error:", error);
      // Fallback to database
      return await dbQuery();
    }
  }

  /**
   * Get single lookup by ID from cache or database
   * @param {string} id - Lookup ID
   * @param {Function} dbQuery - Database query function
   * @returns {Promise<Object|null>} Lookup data
   */
  async getLookupById(id, dbQuery) {
    const cacheKey = `id:${id}`;

    try {
      // Try to get from cache first
      const cached = await this.lookupCache.get(cacheKey);
      if (cached) {
        console.log(`📦 Cache hit: getLookupById(${id})`);
        return cached;
      }

      // Cache miss - fetch from database
      console.log(`💾 Cache miss: getLookupById(${id}) - fetching from DB`);
      const data = await dbQuery();

      // Cache the result (only if found)
      if (data && this.lookupCache.enabled) {
        await this.lookupCache.set(cacheKey, data);
      }

      return data;
    } catch (error) {
      console.error("Lookup cache error:", error);
      // Fallback to database
      return await dbQuery();
    }
  }

  /**
   * Invalidate lookup cache
   * @param {string} id - Optional specific lookup ID
   */
  async invalidateLookupCache(id = null) {
    if (!this.lookupCache.enabled) return;

    try {
      if (id) {
        // Invalidate specific lookup
        await this.lookupCache.del(`id:${id}`);
        console.log(`🗑️ Invalidated lookup cache for ID: ${id}`);
      } else {
        // Invalidate all lookup cache
        await this.lookupCache.del("all");
        console.log("🗑️ Invalidated all lookup cache");
      }
    } catch (error) {
      console.error("Lookup cache invalidation error:", error);
    }
  }

  /**
   * Get lookup hierarchy from cache or database
   * @param {string} id - Lookup ID
   * @param {Function} dbQuery - Database query function
   * @returns {Promise<Object|null>} Lookup hierarchy data
   */
  async getLookupHierarchy(id, dbQuery) {
    const cacheKey = `hierarchy:${id}`;

    try {
      // Try to get from cache first
      const cached = await this.hierarchyCache.get(cacheKey);
      if (cached) {
        console.log(`📦 Cache hit: getLookupHierarchy(${id})`);
        return cached;
      }

      // Cache miss - fetch from database
      console.log(
        `💾 Cache miss: getLookupHierarchy(${id}) - fetching from DB`
      );
      const data = await dbQuery();

      // Cache the result (only if found)
      if (data && this.hierarchyCache.enabled) {
        await this.hierarchyCache.set(cacheKey, data);
      }

      return data;
    } catch (error) {
      console.error("Lookup hierarchy cache error:", error);
      // Fallback to database
      return await dbQuery();
    }
  }

  /**
   * Get lookups by type with hierarchy from cache or database
   * @param {string} lookuptypeId - Lookup type ID
   * @param {Function} dbQuery - Database query function
   * @returns {Promise<Object|null>} Lookups by type with hierarchy data
   */
  async getLookupsByTypeWithHierarchy(lookuptypeId, dbQuery) {
    const cacheKey = `type:${lookuptypeId}`;

    try {
      // Try to get from cache first
      const cached = await this.lookupTypeHierarchyCache.get(cacheKey);
      if (cached) {
        console.log(
          `📦 Cache hit: getLookupsByTypeWithHierarchy(${lookuptypeId})`
        );
        return cached;
      }

      // Cache miss - fetch from database
      console.log(
        `💾 Cache miss: getLookupsByTypeWithHierarchy(${lookuptypeId}) - fetching from DB`
      );
      const data = await dbQuery();

      // Cache the result (only if found)
      if (data && this.lookupTypeHierarchyCache.enabled) {
        await this.lookupTypeHierarchyCache.set(cacheKey, data);
      }

      return data;
    } catch (error) {
      console.error("Lookup type hierarchy cache error:", error);
      // Fallback to database
      return await dbQuery();
    }
  }

  /**
   * Invalidate hierarchy cache
   * @param {string} id - Optional specific lookup ID
   * @param {string} lookuptypeId - Optional specific lookup type ID
   */
  async invalidateHierarchyCache(id = null, lookuptypeId = null) {
    if (!this.hierarchyCache.enabled && !this.lookupTypeHierarchyCache.enabled)
      return;

    try {
      if (id) {
        // Invalidate specific lookup hierarchy
        await this.hierarchyCache.del(`hierarchy:${id}`);
        console.log(`🗑️ Invalidated hierarchy cache for ID: ${id}`);
      }

      if (lookuptypeId) {
        // Invalidate specific lookup type hierarchy
        await this.lookupTypeHierarchyCache.del(`type:${lookuptypeId}`);
        console.log(
          `🗑️ Invalidated lookup type hierarchy cache for type: ${lookuptypeId}`
        );
      }

      if (!id && !lookuptypeId) {
        // Invalidate all hierarchy caches
        await this.hierarchyCache.clear();
        await this.lookupTypeHierarchyCache.clear();
        console.log("🗑️ Invalidated all hierarchy caches");
      }
    } catch (error) {
      console.error("Hierarchy cache invalidation error:", error);
    }
  }

  // ===== LOOKUP TYPE CACHE METHODS =====

  /**
   * Get all lookup types from cache or database
   * @param {Function} dbQuery - Database query function
   * @returns {Promise<Array>} Lookup type data
   */
  async getAllLookupTypes(dbQuery) {
    const cacheKey = "all";

    try {
      // Try to get from cache first
      const cached = await this.lookupTypeCache.get(cacheKey);
      if (cached) {
        console.log("📦 Cache hit: getAllLookupTypes");
        return cached;
      }

      // Cache miss - fetch from database
      console.log("💾 Cache miss: getAllLookupTypes - fetching from DB");
      const data = await dbQuery();

      // Cache the result
      if (this.lookupTypeCache.enabled) {
        await this.lookupTypeCache.set(cacheKey, data);
      }

      return data;
    } catch (error) {
      console.error("Lookup type cache error:", error);
      // Fallback to database
      return await dbQuery();
    }
  }

  /**
   * Get single lookup type by ID from cache or database
   * @param {string} id - Lookup type ID
   * @param {Function} dbQuery - Database query function
   * @returns {Promise<Object|null>} Lookup type data
   */
  async getLookupTypeById(id, dbQuery) {
    const cacheKey = `id:${id}`;

    try {
      // Try to get from cache first
      const cached = await this.lookupTypeCache.get(cacheKey);
      if (cached) {
        console.log(`📦 Cache hit: getLookupTypeById(${id})`);
        return cached;
      }

      // Cache miss - fetch from database
      console.log(`💾 Cache miss: getLookupTypeById(${id}) - fetching from DB`);
      const data = await dbQuery();

      // Cache the result (only if found)
      if (data && this.lookupTypeCache.enabled) {
        await this.lookupTypeCache.set(cacheKey, data);
      }

      return data;
    } catch (error) {
      console.error("Lookup type cache error:", error);
      // Fallback to database
      return await dbQuery();
    }
  }

  /**
   * Invalidate lookup type cache
   * @param {string} id - Optional specific lookup type ID
   */
  async invalidateLookupTypeCache(id = null) {
    if (!this.lookupTypeCache.enabled) return;

    try {
      if (id) {
        // Invalidate specific lookup type
        await this.lookupTypeCache.del(`id:${id}`);
        console.log(`🗑️ Invalidated lookup type cache for ID: ${id}`);
      } else {
        // Invalidate all lookup type cache
        await this.lookupTypeCache.del("all");
        console.log("🗑️ Invalidated all lookup type cache");
      }
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
   * Clear all lookup-related caches
   */
  async clearAllCaches() {
    try {
      await this.lookupCache.clear();
      await this.lookupTypeCache.clear();
      await this.countryCache.clear();
      await this.hierarchyCache.clear();
      await this.lookupTypeHierarchyCache.clear();
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
      };
    } catch (error) {
      console.error("Error getting cache stats:", error);
      return { error: error.message };
    }
  }
}

// Export singleton instance
module.exports = new LookupCacheService();
