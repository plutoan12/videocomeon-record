# Screen Recorder for videocomeon.com

> **⚠️ 이 저장소는 아카이브되었습니다.** 소스가 [plutoan12/videocomeon-local](https://github.com/plutoan12/videocomeon-local)의 `apps/web/public/record/`로 이관되어 그곳에서 유지보수됩니다. 이슈·수정은 videocomeon-local에 올려 주세요.

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
- **Mute**: 선택 구간만 소리 제거 (배경음악·나레이션은 유지) — 알림음 등 지우기
- **Speed**: 0.5x / 0.75x / 1x / 1.5x / 2x
- **Volume**: 클립 볼륨 0–200%, 배경음악 볼륨 0–200%
- **Rotate**: 90° 단위 회전
- **Crop**: 드래그로 영역을 지정해 그 부분만 내보내기 (3×3 격자 가이드)
- **Ratio**: 화면비 변환 — Original / 9:16(쇼츠·릴스) / 1:1 / 4:5 / 16:9, 남는 영역은 블러 배경으로 채움 (최대 1920px로 자동 캡)
- **Facecam**: 웹캠 PIP — 영상을 재생하면서 웹캠 리액션을 미리 녹화해 클립으로 합성 (여러 클립 추가/삭제, 드래그 이동, 모서리로 크기 조절)
- **Audio**: 배경음악 파일 추가(루프)
- **Voice**: 보이스오버 — 영상을 재생하면서 마이크 나레이션 녹음, 여러 클립 추가/삭제, 볼륨 조절
- **Text / Watermark**: 텍스트 오버레이(색상·크기 선택, 드래그 배치, 여러 개) + 이미지 워터마크(드래그·크기 조절)
- **Filter**: 밝기·대비·채도 슬라이더, 흑백(Mono)/세피아 프리셋
- **Fade**: 시작/끝 페이드 인·아웃 (0.5/1/2초) — 화면과 소리 모두
- **스티커**: 이모지 8종을 탭 한 번으로 배치 (텍스트처럼 드래그·삭제)
- **프레임 캡처**: 현재 장면(오버레이 포함)을 PNG로 저장
- **Undo / Redo**: 컷편집·속도·볼륨·회전·텍스트·워터마크·나레이션·음악·필터·페이드 변경 실행취소/다시실행 (최대 60단계)
- **키보드 단축키**: Space 재생/정지, S Split, Del 구간 삭제, M Mute, ←/→ 1초 이동(Shift: 5초), ,/. 프레임 이동, Home/End 처음/끝, Ctrl+Z / Ctrl+Shift+Z 실행취소/다시실행, Esc 패널 닫기
- **Export**: 편집 결과를 브라우저 안에서 재인코딩 후 새 파일로 저장 — 오버레이·나레이션·음악이 모두 합성됨. WebCodecs 지원 브라우저에서는 **하드웨어 인코딩(mediabunny)** 으로 실시간보다 빠르게 mp4로 직접 출력되며, 오디오는 OfflineAudioContext로 논리 시간에 렌더링되어 싱크가 정확하고, 배속 시 클립 소리는 피치를 유지한 채(WSOLA) 타임스트레치됨. WebCodecs 미지원 브라우저는 기존 실시간(MediaRecorder) 경로로 자동 폴백

### 저장 / 관리
- **미리보기**: SAVE(다운로드) / SHARE(Web Share) / EDIT / DELETE
- **My Videos 라이브러리**: Recording / Edit File 탭, 썸네일·길이 표시, Save / Edit / Rename / Delete
- **영상 가져오기**: 기기의 영상 파일을 라이브러리로 불러와 동일하게 편집
- **클립 이어붙이기**: 라이브러리에서 여러 클립을 순서대로 선택해 하나의 영상으로 합치기 — 같은 코덱이면 mediabunny 패킷 복사로 재인코딩 없이 즉시(1초 미만) 병합 (실패 시 ffmpeg.wasm 스트림 카피 → 실시간 재인코딩 순 폴백)
- **MP4 변환**: webm 항목의 MP4 버튼으로 H.264+AAC mp4 변환 후 다운로드 — mediabunny(WebCodecs 하드웨어 인코딩, 엔진 다운로드 없음) 우선, WebCodecs 미지원 시 ffmpeg.wasm 폴백
- **GIF 변환**: GIF 버튼으로 움직이는 GIF 저장 (최대 480px·12fps, 2-pass 팔레트로 색 품질 확보)
- **MP3 추출**: MP3 버튼으로 영상의 소리만 MP3(192kbps)로 저장
- **Export format 설정**: Auto(브라우저 기본, 빠름) / MP4(호환성) — MP4 모드에서는 브라우저가 mp4 녹화를 지원하면 그대로, 아니면 내보내기 후 자동 변환

## 구조

빌드 과정이 없는 순수 정적 사이트입니다. 런타임 CDN 의존성이 없습니다(ffmpeg.wasm은 저장소에 포함해 자체 호스팅).

```
index.html      화면 구성 (홈 / 라이브러리 / 편집 / 미리보기)
css/style.css   WeRec 스타일 핑크·다크 테마
js/db.js        IndexedDB 저장소
js/mbmedia.js   mediabunny 래퍼 (지연 로딩) — MP4 변환(WebCodecs), 무재인코딩 병합(패킷 복사), 편집기 빠른 내보내기 로더
js/transcode.js ffmpeg.wasm 래퍼 (지연 로딩) — GIF 변환, MP3 추출, MP4 변환·병합 폴백
js/recorder.js  녹화 엔진 (getDisplayMedia + 오디오 믹싱 + MediaRecorder)
js/editor.js    편집기 (타임라인·컷편집·속도·볼륨·회전·크롭·화면비·필터·페이드·페이스캠·BGM·보이스오버·텍스트/스티커/워터마크·캡처·Undo/Redo·내보내기: WebCodecs 우선 + 실시간 폴백)
js/app.js       앱 와이어링 (설정, 녹화 플로우, 라이브러리, 미리보기, 병합/가져오기)
vendor/mediabunny/ mediabunny 1.55 (~660KB, 순수 JS) — 디먹싱·먹싱·WebCodecs 인코딩, 최초 사용 시에만 로딩
vendor/ffmpeg/  ffmpeg.wasm 0.12 (GPL, libx264 포함) — GIF·MP3 및 폴백용, 최초 사용 시에만 ~32MB 로딩
```

참고: `vendor/ffmpeg/`의 ffmpeg.wasm 코어는 GPL 라이선스(libx264 포함), `vendor/mediabunny/`는 MPL-2.0 라이선스입니다.

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

- 내보내기(Export)는 WebCodecs 지원 브라우저(데스크톱 Chrome/Edge, Safari 16.4+)에서는 기기 성능이 허용하는 만큼 빠르게 처리됩니다. WebCodecs 미지원(예: Firefox) 시에는 실시간 재생하며 다시 인코딩하는 폴백 경로를 사용하므로 편집 후 길이만큼 시간이 걸리며, 진행 중 탭을 백그라운드로 보내면 프레임이 끊길 수 있습니다.
- 녹화본은 서버로 전송되지 않습니다. 브라우저 데이터 삭제 시 사라지므로 중요한 파일은 SAVE로 다운로드해 두세요.
