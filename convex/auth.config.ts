// Convex validates the JWTs that Convex Auth issues from this same deployment.
export default {
	providers: [{ domain: process.env.CONVEX_SITE_URL, applicationID: 'convex' }]
};
