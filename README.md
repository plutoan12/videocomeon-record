# Screen Recorder for videocomeon.com

브라우저에서 바로 사용하는 화면 녹화기입니다. 설치·회원가입·업로드 없이 동작하며, 녹화본은 사용자의 브라우저(IndexedDB) 안에만 저장됩니다.

## 현재 기능 (1단계 — 녹화)

- **화면 녹화**: 전체 화면 / 창 / 브라우저 탭 선택 녹화 (`getDisplayMedia` + `MediaRecorder`)
- **오디오**: 시스템(탭) 오디오 + 마이크 동시 녹음, Web Audio로 자동 믹싱
- **화질 설정**: Auto / 720P / 1080P, 30/60 FPS, 카운트다운(0/3/5초)
- **녹화 제어**: 일시정지 / 재개, 타이머, 브라우저의 "공유 중지" 버튼으로도 정지
- **미리보기**: 녹화 직후 재생, SAVE(다운로드) / SHARE(Web Share) / DELETE
- **My Videos 라이브러리**: 썸네일·길이 표시, Save / Rename / Delete

## 예정 기능 (2단계 — 편집)

- 타임라인 컷편집(Trim / Split / Delete), Speed, Volume, Rotate
- Facecam(웹캠 PIP) 및 배경음악 추가
- 편집 결과 재인코딩 후 저장(Edit File 탭)

## 배포

빌드 과정이 없는 순수 정적 사이트입니다. `index.html`, `css/`, `js/` 를 그대로 웹 서버에 올리면 됩니다.

- videocomeon.com 에 추가할 때: 예) `/record/` 경로에 이 저장소 파일을 복사하고 링크만 걸면 됩니다.
- GitHub Pages, Netlify, Cloudflare Pages 등에서도 바로 호스팅 가능합니다.
- 외부 라이브러리/CDN 의존성이 전혀 없습니다.

## 브라우저 지원

| 기능 | 지원 |
|---|---|
| 화면 녹화 | 데스크톱 Chrome / Edge / Firefox / Safari 17+ |
| 시스템 오디오 | Chrome/Edge: 탭 오디오(모든 OS), 전체 화면 오디오(Windows) |
| 모바일 | `getDisplayMedia` 미지원 — 기기 내장 화면 녹화 사용 안내 |

## 로컬 실행

```bash
# 아무 정적 서버로 실행
npx serve .
# 또는
python3 -m http.server 8000
```

`http://localhost:8000` 접속 후 빨간 버튼으로 녹화를 시작합니다. (화면 캡처 API는 `localhost` 또는 HTTPS에서만 동작합니다.)
