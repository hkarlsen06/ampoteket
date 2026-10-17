import { httpRouter } from 'convex/server';
import { auth } from './auth';

// Only Convex Auth's own routes (JWKS and OpenID configuration).
const http = httpRouter();
auth.addHttpRoutes(http);
export default http;
