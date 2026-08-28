# Screen Recorder for videocomeon.com

브라우저에서 바로 사용하는 화면 녹화 + 컷편집기입니다. 설치·회원가입·업로드 없이 동작하며, 녹화·편집본은 사용자의 브라우저(IndexedDB) 안에만 저장됩니다.

## 기능

### 녹화
- **화면 녹화**: 전체 화면 / 창 / 브라우저 탭 선택 녹화 (`getDisplayMedia` + `MediaRecorder`)
- **오디오**: 시스템(탭) 오디오 + 마이크 동시 녹음, Web Audio로 자동 믹싱
- **화질 설정**: Auto / 720P / 1080P, 30/60 FPS, 카운트다운(0/3/5초)
- **녹화 제어**: 일시정지 / 재개, 타이머, 브라우저의 "공유 중지" 버튼으로도 정지

### 편집 (Edit)
- **타임라인**: 필름스트립 썸네일, 재생 헤드 스크럽
- **컷편집**: 좌우 핸들로 Trim, 재생 위치에서 Split, 선택 구간 Delete
- **Speed**: 0.5x / 0.75x / 1x / 1.5x / 2x
- **Volume**: 클립 볼륨 0–200%, 배경음악 볼륨 0–200%
- **Rotate**: 90° 단위 회전
- **Facecam**: 웹캠 PIP 오버레이 — 드래그 이동, 모서리로 크기 조절
- **Audio**: 배경음악 파일 추가(루프)
- **Voice**: 보이스오버 — 영상을 재생하면서 마이크 나레이션 녹음, 여러 클립 추가/삭제, 볼륨 조절
- **Text / Watermark**: 텍스트 오버레이(색상·크기 선택, 드래그 배치, 여러 개) + 이미지 워터마크(드래그·크기 조절)
- **Filter**: 밝기·대비·채도 슬라이더, 흑백(Mono)/세피아 프리셋
- **Fade**: 시작/끝 페이드 인·아웃 (0.5/1/2초) — 화면과 소리 모두
- **스티커**: 이모지 8종을 탭 한 번으로 배치 (텍스트처럼 드래그·삭제)
- **프레임 캡처**: 현재 장면(오버레이 포함)을 PNG로 저장
- **Undo / Redo**: 컷편집·속도·볼륨·회전·텍스트·워터마크·나레이션·음악·필터·페이드 변경 실행취소/다시실행 (최대 60단계)
- **Export**: 편집 결과를 브라우저 안에서 재인코딩(실시간) 후 새 파일로 저장 — 오버레이·나레이션·음악이 모두 합성됨

### 저장 / 관리
- **미리보기**: SAVE(다운로드) / SHARE(Web Share) / EDIT / DELETE
- **My Videos 라이브러리**: Recording / Edit File 탭, 썸네일·길이 표시, Save / Edit / Rename / Delete

## 구조

빌드 과정이 없는 순수 정적 사이트입니다. 외부 라이브러리/CDN 의존성이 없습니다.

```
index.html      화면 구성 (홈 / 라이브러리 / 편집 / 미리보기)
css/style.css   WeRec 스타일 핑크·다크 테마
js/db.js        IndexedDB 저장소
js/recorder.js  녹화 엔진 (getDisplayMedia + 오디오 믹싱 + MediaRecorder)
js/editor.js    편집기 (타임라인·컷편집·속도·볼륨·회전·필터·페이드·페이스캠·BGM·보이스오버·텍스트/스티커/워터마크·캡처·Undo/Redo·내보내기)
js/app.js       앱 와이어링 (설정, 녹화 플로우, 라이브러리, 미리보기)
```

## 배포

`index.html`, `css/`, `js/` 를 그대로 웹 서버에 올리면 됩니다.

- **GitHub Pages**: Settings → Pages → Branch `main` / root → Save → `https://<계정>.github.io/videocomeon-record/`
- **videocomeon.com 에 추가**: 예) `/record/` 경로에 이 저장소 파일을 복사하고 링크만 걸면 됩니다.
- 화면 캡처 API는 **HTTPS(또는 localhost)** 에서만 동작합니다.

## 브라우저 지원

| 기능 | 지원 |
|---|---|
| 화면 녹화 | 데스크톱 Chrome / Edge / Firefox / Safari 17+ |
| 시스템 오디오 | Chrome/Edge: 탭 오디오(모든 OS), 전체 화면 오디오(Windows) |
| 편집·내보내기 | MediaRecorder 지원 브라우저 (출력 형식은 브라우저에 따라 webm 또는 mp4) |
| 모바일 | `getDisplayMedia` 미지원 — 기기 내장 화면 녹화 사용 안내 |

## 로컬 실행

```bash
python3 -m http.server 8000
# 또는
npx serve .
```

`http://localhost:8000` 접속 후 빨간 버튼으로 녹화를 시작합니다.

## 참고

- 내보내기(Export)는 편집 결과를 실시간 재생하며 다시 인코딩하므로, 편집 후 길이만큼 시간이 걸립니다. 진행 중 탭을 백그라운드로 보내면 프레임이 끊길 수 있습니다.
- 녹화본은 서버로 전송되지 않습니다. 브라우저 데이터 삭제 시 사라지므로 중요한 파일은 SAVE로 다운로드해 두세요.
