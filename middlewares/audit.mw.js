const { AppError } = require("../errors/AppError");
const fs = require("fs").promises;
const path = require("path");

/**
 * Audit Logging Middleware
 * Logs security-sensitive operations and events
 */
class AuditLogger {
  constructor() {
    this.logDir = path.join(process.cwd(), "logs", "audit");
    this.initializeLogDirectory();
  }

  async initializeLogDirectory() {
    try {
      await fs.mkdir(this.logDir, { recursive: true });
    } catch (error) {
      console.error("Failed to create audit log directory:", error);
    }
  }

  async log(auditEvent) {
    try {
      const logEntry = {
        timestamp: new Date().toISOString(),
        requestId: auditEvent.requestId,
        userId: auditEvent.userId,
        tenantId: auditEvent.tenantId,
        action: auditEvent.action,
        resource: auditEvent.resource,
        result: auditEvent.result,
        ipAddress: auditEvent.ipAddress,
        userAgent: auditEvent.userAgent,
        details: auditEvent.details || {},
        riskLevel: auditEvent.riskLevel || "LOW",
      };

      const logFile = path.join(
        this.logDir,
        `audit-${new Date().toISOString().split("T")[0]}.log`
      );

      await fs.appendFile(logFile, JSON.stringify(logEntry) + "\n");
    } catch (error) {
      console.error("Failed to write audit log:", error);
    }
  }

  // High-risk operations
  async logAuthenticationAttempt(req, success, details = {}) {
    await this.log({
      requestId: req.requestId,
      userId: req.ctx?.userId,
      tenantId: req.ctx?.tenantId,
      action: "AUTHENTICATION_ATTEMPT",
      resource: "AUTH",
      result: success ? "SUCCESS" : "FAILURE",
      ipAddress: req.ip || req.connection.remoteAddress,
      userAgent: req.get("User-Agent"),
      details,
      riskLevel: success ? "LOW" : "HIGH",
    });
  }

  async logLogout(req, success, details = {}) {
    await this.log({
      requestId: req.requestId,
      userId: req.ctx?.userId,
      tenantId: req.ctx?.tenantId,
      action: "LOGOUT",
      resource: "AUTH",
      result: success ? "SUCCESS" : "FAILURE",
      ipAddress: req.ip || req.connection.remoteAddress,
      userAgent: req.get("User-Agent"),
      details: {
        logoutTime: new Date().toISOString(),
        tokensRevoked: success,
        ...details,
      },
      riskLevel: "MEDIUM",
    });
  }

  async logRoleAssignment(req, targetUserId, roleId, success) {
    await this.log({
      requestId: req.requestId,
      userId: req.ctx?.userId,
      tenantId: req.ctx?.tenantId,
      action: "ROLE_ASSIGNMENT",
      resource: "ROLE",
      result: success ? "SUCCESS" : "FAILURE",
      ipAddress: req.ip || req.connection.remoteAddress,
      userAgent: req.get("User-Agent"),
      details: {
        targetUserId,
        roleId,
      },
      riskLevel: "HIGH",
    });
  }

  async logPermissionChange(req, resource, action, success) {
    await this.log({
      requestId: req.requestId,
      userId: req.ctx?.userId,
      tenantId: req.ctx?.tenantId,
      action: "PERMISSION_CHANGE",
      resource,
      result: success ? "SUCCESS" : "FAILURE",
      ipAddress: req.ip || req.connection.remoteAddress,
      userAgent: req.get("User-Agent"),
      details: { action },
      riskLevel: "HIGH",
    });
  }

  async logDataAccess(req, resource, action, success) {
    await this.log({
      requestId: req.requestId,
      userId: req.ctx?.userId,
      tenantId: req.ctx?.tenantId,
      action: "DATA_ACCESS",
      resource,
      result: success ? "SUCCESS" : "FAILURE",
      ipAddress: req.ip || req.connection.remoteAddress,
      userAgent: req.get("User-Agent"),
      details: { action },
      riskLevel: "MEDIUM",
    });
  }

  async logSecurityViolation(req, violation, details = {}) {
    await this.log({
      requestId: req.requestId,
      userId: req.ctx?.userId,
      tenantId: req.ctx?.tenantId,
      action: "SECURITY_VIOLATION",
      resource: "SECURITY",
      result: "VIOLATION",
      ipAddress: req.ip || req.connection.remoteAddress,
      userAgent: req.get("User-Agent"),
      details: {
        violation,
        ...details,
      },
      riskLevel: "CRITICAL",
    });
  }

  async logTenantAccess(req, targetTenantId, success) {
    await this.log({
      requestId: req.requestId,
      userId: req.ctx?.userId,
      tenantId: req.ctx?.tenantId,
      action: "TENANT_ACCESS",
      resource: "TENANT",
      result: success ? "SUCCESS" : "FAILURE",
      ipAddress: req.ip || req.connection.remoteAddress,
      userAgent: req.get("User-Agent"),
      details: {
        targetTenantId,
        requestedTenant: req.ctx?.tenantId,
      },
      riskLevel: success ? "MEDIUM" : "HIGH",
    });
  }
}

const auditLogger = new AuditLogger();

/**
 * Audit Middleware for Role Assignment
 */
const auditRoleAssignment = async (req, res, next) => {
  const originalSend = res.send;

  res.send = function (data) {
    // Log the role assignment attempt
    const { userId, roleId } = req.body;
    const success = res.statusCode >= 200 && res.statusCode < 300;

    auditLogger.logRoleAssignment(req, userId, roleId, success);

    return originalSend.call(this, data);
  };

  next();
};

/**
 * Audit Middleware for Permission Changes
 */
const auditPermissionChange = async (req, res, next) => {
  const originalSend = res.send;

  res.send = function (data) {
    const success = res.statusCode >= 200 && res.statusCode < 300;
    const resource = req.route?.path || req.path;
    const action = req.method;

    auditLogger.logPermissionChange(req, resource, action, success);

    return originalSend.call(this, data);
  };

  next();
};

/**
 * Audit Middleware for Data Access
 */
const auditDataAccess = (resource) => {
  return async (req, res, next) => {
    const originalSend = res.send;

    res.send = function (data) {
      const success = res.statusCode >= 200 && res.statusCode < 300;
      const action = req.method;

      auditLogger.logDataAccess(req, resource, action, success);

      return originalSend.call(this, data);
    };

    next();
  };
};

/**
 * Audit Middleware for Authentication
 */
const auditAuthentication = async (req, res, next) => {
  const originalSend = res.send;

  res.send = function (data) {
    const success = res.statusCode >= 200 && res.statusCode < 300;

    auditLogger.logAuthenticationAttempt(req, success, {
      endpoint: req.path,
      method: req.method,
    });

    return originalSend.call(this, data);
  };

  next();
};

/**
 * Audit Middleware for Security Violations
 */
const auditSecurityViolation = (violation, details = {}) => {
  return async (req, res, next) => {
    auditLogger.logSecurityViolation(req, violation, details);
    next();
  };
};

/**
 * Audit Middleware for Tenant Access
 */
const auditTenantAccess = async (req, res, next) => {
  const originalSend = res.send;

  res.send = function (data) {
    const success = res.statusCode >= 200 && res.statusCode < 300;
    const targetTenantId = req.params.tenantId || req.query.tenantId;

    if (targetTenantId) {
      auditLogger.logTenantAccess(req, targetTenantId, success);
    }

    return originalSend.call(this, data);
  };

  next();
};

/**
 * Security Event Monitor
 * Monitors for suspicious patterns
 */
class SecurityMonitor {
  constructor() {
    this.failedAttempts = new Map();
    this.suspiciousIPs = new Set();
    this.alertThresholds = {
      failedAuthAttempts: 5,
      suspiciousRequests: 10,
      timeWindow: 15 * 60 * 1000, // 15 minutes
    };
  }

  async checkFailedAttempts(ipAddress, userId) {
    const key = `${ipAddress}:${userId || "anonymous"}`;
    const attempts = this.failedAttempts.get(key) || [];

    // Clean old attempts
    const now = Date.now();
    const recentAttempts = attempts.filter(
      (attempt) => now - attempt < this.alertThresholds.timeWindow
    );

    this.failedAttempts.set(key, recentAttempts);

    if (recentAttempts.length >= this.alertThresholds.failedAuthAttempts) {
      this.suspiciousIPs.add(ipAddress);
      return true;
    }

    return false;
  }

  recordFailedAttempt(ipAddress, userId) {
    const key = `${ipAddress}:${userId || "anonymous"}`;
    const attempts = this.failedAttempts.get(key) || [];
    attempts.push(Date.now());
    this.failedAttempts.set(key, attempts);
  }

  isSuspiciousIP(ipAddress) {
    return this.suspiciousIPs.has(ipAddress);
  }

  async generateSecurityReport() {
    const report = {
      timestamp: new Date().toISOString(),
      suspiciousIPs: Array.from(this.suspiciousIPs),
      failedAttempts: Object.fromEntries(this.failedAttempts),
      recommendations: [],
    };

    if (this.suspiciousIPs.size > 0) {
      report.recommendations.push("Consider blocking suspicious IP addresses");
    }

    return report;
  }
}

const securityMonitor = new SecurityMonitor();

module.exports = {
  auditLogger,
  auditRoleAssignment,
  auditPermissionChange,
  auditDataAccess,
  auditAuthentication,
  auditSecurityViolation,
  auditTenantAccess,
  securityMonitor,
};
