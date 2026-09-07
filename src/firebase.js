import { initializeApp } from "firebase/app";
import { getAuth, connectAuthEmulator } from "firebase/auth";
import { getFirestore, connectFirestoreEmulator } from "firebase/firestore";
import { getStorage } from "firebase/storage";
import { getAnalytics } from "firebase/analytics";

// Vite exposes VITE_-prefixed variables on import.meta.env (not process.env).
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
};

// Validate config
if (!firebaseConfig.apiKey || firebaseConfig.apiKey.startsWith('YOUR')) {
  console.error('Firebase config missing. Please set the VITE_FIREBASE_* env vars (see .env.example).');
}

const app = initializeApp(firebaseConfig);

// Analytics is optional — it can throw when the project has it disabled.
if (firebaseConfig.measurementId) {
  try {
    getAnalytics(app);
  } catch (error) {
    console.warn('Firebase Analytics unavailable:', error.message);
  }
}

export const auth = getAuth(app);
export const db = getFirestore(app);

// Camera check-in photos need a Storage bucket. Null when the env var is
// unset so the rest of the app keeps working; callers must guard on this.
export const storageBucketConfigured = Boolean(firebaseConfig.storageBucket);
export const storage = storageBucketConfigured ? getStorage(app) : null;

// Local E2E testing: point the SDK at the Firebase emulators when
// VITE_USE_FIREBASE_EMULATORS=true (see firebase.json for the ports).
const useEmulators = import.meta.env.VITE_USE_FIREBASE_EMULATORS === 'true';
if (useEmulators) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
}