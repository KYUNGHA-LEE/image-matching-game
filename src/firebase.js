// Firebase 초기화 모듈

import { initializeApp } from "firebase/app";
import { getDatabase } from "firebase/database";
import { getAuth, signInAnonymously, onAuthStateChanged } from "firebase/auth";

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
export const auth = getAuth(app);

// 익명 인증: 앱에 접속하면 자동으로(보이지 않게) 로그인한다.
// 보안 규칙을 "auth != null"로 두면, 앱을 거치지 않은 외부인의 DB 접근이 차단된다.
// authReady : 로그인이 끝나면 resolve 되는 약속(Promise). DB 구독을 이 뒤로 미룬다.
export const authReady = new Promise((resolve) => {
  onAuthStateChanged(auth, (user) => {
    if (user) resolve(user);
  });
  signInAnonymously(auth).catch((e) => {
    console.error("익명 로그인 실패:", e);
    resolve(null); // 로그인이 안 돼도 앱은 진행 (규칙이 허용하면 동작)
  });
});
