#!/usr/bin/env node

/**
 * Migration Script for Policy Client Hook-based Architecture
 *
 * This script helps identify usage patterns that need to be migrated
 * from class-based to hook-based approach
 */

const fs = require("fs");
const path = require("path");

// Patterns to look for in migration
const MIGRATION_PATTERNS = [
  {
    pattern: /new.*PolicyClient.*useAuthorization/g,
    issue: "Class instance calling useAuthorization hook",
    solution: "Use usePolicyClient hook and separate useAuthorization hook",
  },
  {
    pattern: /new.*PolicyClient.*usePermissions/g,
    issue: "Class instance calling usePermissions hook",
    solution: "Use usePolicyClient hook and separate usePermissions hook",
  },
  {
    pattern: /new.*UIAwarePolicyClient.*useUIInitialization/g,
    issue: "UI class instance calling useUIInitialization hook",
    solution: "Use useUIInitialization hook directly",
  },
  {
    pattern: /class.*extends.*Component.*PolicyClient/g,
    issue: "Class component using PolicyClient with hooks",
    solution: "Convert to function component with hooks",
  },
];

function scanFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const issues = [];

    MIGRATION_PATTERNS.forEach(({ pattern, issue, solution }) => {
      const matches = content.match(pattern);
      if (matches) {
        issues.push({
          file: filePath,
          issue,
          solution,
          matches: matches.length,
        });
      }
    });

    return issues;
  } catch (error) {
    console.warn(`Warning: Could not read file ${filePath}:`, error.message);
    return [];
  }
}

function scanDirectory(dirPath, extensions = [".js", ".jsx", ".ts", ".tsx"]) {
  const issues = [];

  try {
    const items = fs.readdirSync(dirPath);

    for (const item of items) {
      const fullPath = path.join(dirPath, item);
      const stat = fs.statSync(fullPath);

      if (
        stat.isDirectory() &&
        !item.startsWith(".") &&
        item !== "node_modules"
      ) {
        issues.push(...scanDirectory(fullPath, extensions));
      } else if (
        stat.isFile() &&
        extensions.some((ext) => item.endsWith(ext))
      ) {
        issues.push(...scanFile(fullPath));
      }
    }
  } catch (error) {
    console.warn(
      `Warning: Could not scan directory ${dirPath}:`,
      error.message
    );
  }

  return issues;
}

function generateMigrationReport(issues) {
  if (issues.length === 0) {
    console.log(
      "✅ No migration issues found! Your code is already using the correct patterns."
    );
    return;
  }

  console.log("🔍 Policy Client Migration Report");
  console.log("=".repeat(50));
  console.log(`Found ${issues.length} potential migration issues:\n`);

  const groupedIssues = issues.reduce((groups, issue) => {
    if (!groups[issue.issue]) {
      groups[issue.issue] = [];
    }
    groups[issue.issue].push(issue);
    return groups;
  }, {});

  Object.entries(groupedIssues).forEach(([issueType, issueList]) => {
    console.log(`❌ ${issueType}`);
    console.log(`   Solution: ${issueList[0].solution}`);
    console.log("   Files affected:");

    issueList.forEach((issue) => {
      console.log(
        `   - ${issue.file} (${issue.matches} occurrence${
          issue.matches > 1 ? "s" : ""
        })`
      );
    });
    console.log("");
  });

  console.log("📚 Migration Guide:");
  console.log(
    "   See docs/POLICY-CLIENT-ARCHITECTURE.md for detailed migration instructions"
  );
  console.log(
    "   See examples/policy-client-usage-examples.js for updated usage patterns"
  );
}

function main() {
  const args = process.argv.slice(2);
  const scanPath = args[0] || process.cwd();

  console.log(`🔍 Scanning for policy client migration issues in: ${scanPath}`);
  console.log("");

  const issues = scanDirectory(scanPath);
  generateMigrationReport(issues);

  if (issues.length > 0) {
    console.log("\n💡 Quick Migration Tips:");
    console.log(
      "1. Replace class-based PolicyClient instantiation with usePolicyClient hook"
    );
    console.log("2. Move hook calls to the top level of function components");
    console.log(
      "3. Convert class components to function components where needed"
    );
    console.log(
      "4. Use separate hooks for authorization, permissions, and UI initialization"
    );

    process.exit(1); // Exit with error code to indicate migration needed
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  scanFile,
  scanDirectory,
  generateMigrationReport,
  MIGRATION_PATTERNS,
};
