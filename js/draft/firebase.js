import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js';
import {
  getFirestore, doc, collection, onSnapshot, getDoc, getDocs, setDoc, updateDoc,
  runTransaction, serverTimestamp, Timestamp, query, orderBy, limit, deleteField
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';
import { firebaseConfig } from './config.js';

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export { doc, collection, onSnapshot, getDoc, getDocs, setDoc, updateDoc, runTransaction,
  serverTimestamp, Timestamp, query, orderBy, limit, deleteField };
