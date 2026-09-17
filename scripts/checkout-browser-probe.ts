// Bundled only by the disposable test runner; never imported by the application.
import * as checkout from '../src/lib/checkout';
import { readActiveAttempt } from '../src/lib/cart';
(window as unknown as { checkoutProof: unknown }).checkoutProof = { ...checkout, readActiveAttempt };
