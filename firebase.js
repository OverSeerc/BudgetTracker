import { initializeApp } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js";
import {
  getFirestore,
  doc, setDoc, getDoc, updateDoc, deleteDoc,
  collection, addDoc, getDocs,
  query, where, orderBy
} from "https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js";

// Your Firebase config
const firebaseConfig = {
  apiKey: "AIzaSyCPQxyFs5ekzuk4VUnSGNBLRQm09nKwhig",
  authDomain: "budgettracker-c1080.firebaseapp.com",
  projectId: "budgettracker-c1080",
  storageBucket: "budgettracker-c1080.firebasestorage.app",
  messagingSenderId: "423955571132",
  appId: "1:423955571132:web:f0b77743bcc51cc6ae0bb9",
  measurementId: "G-KQ265YK80C"
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);

// re-export helpers
export {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  doc, setDoc, getDoc, updateDoc, deleteDoc,
  collection, addDoc, getDocs,
  query, where, orderBy
};
