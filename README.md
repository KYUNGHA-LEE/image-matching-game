# 클릭클릭 이미지카드 체인지 👆

학생들이 함께 즐기는 **실시간 멀티플레이 이미지 점령 게임**입니다.
선생님이 이미지를 올리고, 학생들은 화면에 뿌려진 타일을 클릭해
내 이미지로 바꿔가며 점수를 겨룹니다. 실시간 랭킹(1~5등)이 표시돼요.

## 🎮 바로 해보기
https://image-matching-game-ochre.vercel.app

## 게임 방법
- **학생**: 닉네임을 입력하고 입장 → 다른 사람의 타일을 클릭해 내 이미지로 점령
- **선생님**: 이미지 업로드 → 매칭 → 시간 설정 후 게임 시작
- 제한 시간 동안 가장 많은 타일을 차지한 사람이 승리!

## 선생님 모드 들어가는 법
- 주소 뒤에 `?mode=admin` 을 붙이세요 (예: `사이트주소/?mode=admin`)
- 예전 방식인 `#leethemom` 도 그대로 동작합니다
- 선생님 비밀번호를 입력하면 관리 화면이 나옵니다
- ⚠️ 포크해서 쓰실 분은 `src/App.jsx`의 `T_PASS` 값을 본인 비밀번호로 바꾸세요

## 기술 스택
- React + Vite
- Firebase Realtime Database (실시간 동기화)
- Web Audio API (효과음)

## 실행 방법
```bash
npm install
npm run dev
```

## 포크해서 직접 쓰려면 (중요)
이 게임은 Firebase 데이터베이스를 사용합니다.
**본인 Firebase 프로젝트를 만들어 연결하지 않으면 원본과 데이터가 섞입니다.**

1. 이 저장소를 Fork
2. [Firebase 콘솔](https://console.firebase.google.com)에서 프로젝트 생성 → Realtime Database 만들기
3. `src/firebase.js` 의 `FIREBASE_CONFIG` 를 본인 프로젝트 설정으로 교체
4. Authentication → 익명(Anonymous) 로그인 사용 설정
5. Realtime Database 규칙을 아래 보안 규칙으로 설정
6. Vercel 등에 배포

보안 규칙:
```json
{
  "rules": {
    ".read": "auth != null",
    ".write": "auth != null"
  }
}
```

## 라이선스
자유롭게 수업에 활용하세요. 개선 제안(Pull Request) 환영합니다! 🙌
