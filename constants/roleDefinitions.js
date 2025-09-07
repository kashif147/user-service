// Role definitions
const PERMISSIONS = require("@membership/shared-constants/permissions");

const ROLE_DEFINITIONS = [
  // System Role
  {
    name: "Super User",
    code: "SU",
    description:
      "Super User with full system access and role management capabilities",
    userType: "SYSTEM",
    permissions: ["*"], // Full access
    isSystemRole: true,
  },
  // Portal Roles
  {
    name: "Member",
    code: "MEMBER",
    description: "Registered member with full portal access",
    userType: "PORTAL",
    permissions: [
      PERMISSIONS.PORTAL.ACCESS,
      PERMISSIONS.PORTAL.PROFILE_READ,
      PERMISSIONS.PORTAL.PROFILE_WRITE,
      PERMISSIONS.ACCOUNT.READ,
      PERMISSIONS.ACCOUNT.PAYMENT,
      PERMISSIONS.ACCOUNT.TRANSACTION_READ,
    ],
  },
  {
    name: "Non-Member",
    code: "NON-MEMBER",
    description: "Non-member with limited portal access",
    userType: "PORTAL",
    permissions: [],
  },
  // CRM Roles
  {
    name: "Read Only",
    code: "REO",
    description: "Read Only access with limited permissions",
    userType: "CRM",
    permissions: [],
  },
  {
    name: "Membership Officer",
    code: "MO",
    description: "Membership Officer",
    userType: "CRM",
    permissions: [],
  },
  {
    name: "Assistant Membership Officer",
    code: "AMO",
    description: "Assistant Membership Officer",
    userType: "CRM",
    permissions: [],
  },
  {
    name: "Accounts Manager",
    code: "AM",
    description: "Accounts Manager",
    userType: "CRM",
    permissions: [],
  },
  {
    name: "Deputy Accounts Manager",
    code: "DAM",
    description: "Deputy Accounts Manager",
    userType: "CRM",
    permissions: [],
  },
  {
    name: "Accounts Assistant",
    code: "AA",
    description: "Accounts Assistant",
    userType: "CRM",
    permissions: [],
  },
  {
    name: "Director of Industrial Relations",
    code: "DIR",
    description: "Director of Industrial Relations",
    userType: "CRM",
    permissions: [],
  },
  {
    name: "Industrial Relation Executive",
    code: "IRE",
    description: "Industrial Relation Executive",
    userType: "CRM",
    permissions: [],
  },
  {
    name: "Assistant Director Industrial Relations",
    code: "ADIR",
    description: "Assistant Director Industrial Relations",
    userType: "CRM",
    permissions: [],
  },
  {
    name: "Industrial Relations Officers",
    code: "IRO",
    description: "Industrial Relations Officers",
    userType: "CRM",
    permissions: [],
  },
  {
    name: "Information Officer",
    code: "IO",
    description: "Information Officer",
    userType: "CRM",
    permissions: [],
  },
  {
    name: "Director of Professional and Regulatory Services",
    code: "DPRS",
    description: "Director of Professional and Regulatory Services",
    userType: "CRM",
    permissions: [],
  },
  {
    name: "Regional Officer",
    code: "RO",
    description: "Regional Officer",
    userType: "CRM",
    permissions: [],
  },
  {
    name: "Branch Officer",
    code: "BO",
    description: "Branch Officer",
    userType: "CRM",
    permissions: [],
  },
  {
    name: "General Secretary",
    code: "GS",
    description: "General Secretary",
    userType: "CRM",
    permissions: [],
  },
  {
    name: "Deputy General Secretary",
    code: "DGS",
    description: "Deputy General Secretary",
    userType: "CRM",
    permissions: [],
  },
  {
    name: "Head of Library Services",
    code: "HLS",
    description: "Head of Library Services",
    userType: "CRM",
    permissions: [],
  },
  {
    name: "Librarian",
    code: "LS",
    description: "Librarian",
    userType: "CRM",
    permissions: [],
  },
  {
    name: "Library Assistant",
    code: "LA",
    description: "Library Assistant",
    userType: "CRM",
    permissions: [],
  },
  {
    name: "Course Coordinator",
    code: "CC",
    description: "Course Coordinator",
    userType: "CRM",
    permissions: [],
  },
  {
    name: "Assistant Course Coordinator",
    code: "ACC",
    description: "Assistant Course Coordinator",
    userType: "CRM",
    permissions: [],
  },
  // AI Agent Role
  {
    name: "AI Agent",
    code: "AI",
    description: "AI Agent with read-only access to all microservices",
    userType: "SYSTEM",
    permissions: [
      PERMISSIONS.READ_ONLY,
      PERMISSIONS.USER.READ,
      PERMISSIONS.ROLE.READ,
      PERMISSIONS.ACCOUNT.READ,
      PERMISSIONS.ACCOUNT.TRANSACTION_READ,
      PERMISSIONS.CRM.MEMBER_READ,
    ],
    isSystemRole: true,
  },
];

module.exports = ROLE_DEFINITIONS;
