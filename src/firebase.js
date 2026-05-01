// Firebase 초기화 모듈

import { initializeApp } from "firebase/app";
import { getDatabase } from "firebase/database";

export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyAG3Hy1aXRS-7vC3LYJ_NcSZOpSny3utzo",
  authDomain: "image-matching-game.firebaseapp.com",
  databaseURL: "https://image-matching-game-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "image-matching-game",
  storageBucket: "image-matching-game.firebasestorage.app",
  messagingSenderId: "337211644711",
  appId: "1:337211644711:web:ec98f896ab09e1b5626702",
  measurementId: "G-WJG0Q9T2ZQ"
};

const app = initializeApp(FIREBASE_CONFIG);
export const db = getDatabase(app);
