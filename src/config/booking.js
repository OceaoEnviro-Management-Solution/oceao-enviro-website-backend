// Business rules. The single source for working days, slot times, horizons and retention.
// Never hard-code these values in a service; import BOOKING instead.

const deepFreeze = (value) => {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        Object.values(value).forEach(deepFreeze);
        Object.freeze(value);
    }
    return value;
};

export const BOOKING = deepFreeze({
    timezone: "Asia/Kolkata",
    vm: {
        workingDays: [1, 2, 3, 4, 5],          // Mon-Fri (0 = Sunday)
        slotTimes: ["10:00", "12:00", "14:00", "16:00"],
        durationMinutes: 60,
        horizonDays: 30,                       // today + 30 inclusive
        minLeadMinutes: 120                    // slot must start >= 2h from now
    },
    callback: {
        workingDays: [1, 2, 3, 4, 5, 6],       // Mon-Sat
        closedSaturdaysOfMonth: [2],           // 2nd Saturday of every month closed
        periods: {
            morning:   { label: "Morning",   start: "09:00", end: "12:00", timeRange: "9 AM – 12 PM", defaultCapacity: 5 },
            afternoon: { label: "Afternoon", start: "12:00", end: "15:00", timeRange: "12 PM – 3 PM", defaultCapacity: 5 },
            evening:   { label: "Evening",   start: "15:00", end: "18:00", timeRange: "3 PM – 6 PM",  defaultCapacity: 3 }
        },
        periodOrder: ["morning", "afternoon", "evening"],
        cutoffMinutesBeforeEnd: 60,            // period closes 1h before it ends
        horizonDays: 30
    },
    retentionDays: 30,                       // bookings/requests/slots deleted 30 days after their date
    auditRetentionDays: 180,
    otp: {
        length: 6,
        validityMinutes: 5,
        resendCooldownSeconds: 60,
        maxSendsPerHour: 5,
        maxAttempts: 5,
        bookingTokenMinutes: 30
    }
});
