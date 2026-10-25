// Careers: the fixed lists and limits of a job opening and of an application (the models and the
// validators both read from here), the resume rules, and the counters' and lists' settings.
// From the environment (src/config/env.js): CAREERS_MAIL (HR inbox, falls back to COMPANY_MAIL)
// and CAREERS_RETENTION_DAYS (applications and resumes are deleted after this many days, default 365).

export const CAREERS = Object.freeze({
    employmentTypes: Object.freeze(["Full-time", "Part-time", "Internship", "Contract"]),
    workModes: Object.freeze(["On-site", "Hybrid", "Remote"]),

    // Text lengths after trimming. Long texts are plain text, one point per line.
    limits: Object.freeze({
        title: Object.freeze({ min: 3, max: 120 }),
        department: Object.freeze({ min: 2, max: 80 }),
        location: Object.freeze({ min: 2, max: 120 }),
        experience: Object.freeze({ min: 0, max: 40 }),      // whole years
        openings: Object.freeze({ min: 1, max: 100 }),
        salaryText: Object.freeze({ max: 80 }),
        summary: Object.freeze({ max: 300 }),
        responsibilities: Object.freeze({ max: 5000 }),
        requirements: Object.freeze({ max: 5000 }),
        niceToHave: Object.freeze({ max: 3000 }),
    }),

    // The slug is the kebab-case title cut to this length, then "-" and 4 random characters.
    slugTitleMax: 60,

    // GET /admin/careers/jobs/:id/stats?days
    statsDefaultDays: 30,
    statsMaxDays: 90,

    // POST /careers/jobs/:slug/view, per IP per hour. Over the limit it answers 200 { counted: false }.
    viewRateLimit: Object.freeze({ limit: 30, windowMinutes: 60 }),

    // POST /careers/jobs/:slug/apply and POST /careers/general-apply (each its own counter), per IP
    // per hour (the global /api limiter applies as well)
    applyRateLimit: Object.freeze({ limit: 5, windowMinutes: 60 }),

    // The resume: one file in the multipart field "resume". Its real type (from the bytes, not the
    // name) must be one of these. Stored PRIVATELY on Cloudinary (raw, type private) in `folder`.
    resume: Object.freeze({
        field: "resume",
        maxBytes: 5 * 1024 * 1024,
        allowedTypes: Object.freeze({
            "application/pdf": "pdf",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
        }),
        folder: "oceao/resumes",
        originalNameMax: 120,
        downloadLinkMinutes: 5,
    }),

    // The apply form has more text fields than the general upload limit allows
    applyMaxFields: 20,

    noticePeriods: Object.freeze(["Immediate", "15 days", "30 days", "60 days", "90 days", "More than 90 days"]),
    applicationStatuses: Object.freeze(["new", "shortlisted", "rejected", "hired"]),

    // Application text lengths after trimming
    applicationLimits: Object.freeze({
        fullName: Object.freeze({ min: 2, max: 100 }),
        email: Object.freeze({ max: 254 }),
        phoneDigits: Object.freeze({ min: 7, max: 15 }),
        currentLocation: Object.freeze({ min: 2, max: 80 }),
        totalExperienceYears: Object.freeze({ min: 0, max: 50, step: 0.5 }),
        currentOrganisation: Object.freeze({ max: 120 }),
        currentDesignation: Object.freeze({ max: 120 }),
        highestQualification: Object.freeze({ min: 2, max: 120 }),
        expectedCtc: Object.freeze({ max: 40 }),
        profileUrl: Object.freeze({ max: 300 }),
        coverNote: Object.freeze({ max: 2000 }),
        // general applications only: the role the candidate is looking for
        desiredRole: Object.freeze({ min: 2, max: 120 }),
    }),

    // GET /admin/careers/jobs/:id/applications
    applicationsPageSize: 20,
});
