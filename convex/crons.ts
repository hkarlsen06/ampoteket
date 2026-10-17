import { cronJobs } from 'convex/server';
import { internal } from './_generated/api';

const crons = cronJobs();

// Contact retention (docs/runbook-contact-retention.md): once a day, at night in Oslo.
crons.daily('clear expired checkout contacts', { hourUTC: 2, minuteUTC: 15 }, internal.retention.clearExpiredContacts, {});

export default crons;
