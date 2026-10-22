#!/usr/bin/env node
// Mission 094 Phase 1 task 1.5 — CURRENT RUN + LIVE PROGRESS renderers
// (`scripts/watch-report.mjs`). The standalone fixture mirrors the watcher.md
// "## Example" mission 021 so the golden fragments can be asserted verbatim;
// a second fixture proves the orchestrator-gate variant (`GATE (orchestrator
// full suite, no agent)`, `command:`, `N/M runs · N passed · F failed`).
// Asserts the live-only contract (no CURRENT RUN once the mission is finished),
// the PREP/START/WARN decoded feed, that raw JSON / streaming noise never reach
// the report, and the helper formatting.
import {
  buildReportModel,
  renderReport,
  renderCurrentRun,
  renderLiveProgress,
  decodeLiveProgress,
  currentStageText,
} from "./watch-report.mjs";

// Mission 095's real planner progress.log, embedded verbatim (backlog #6): the
// test never reads .autopilot. 2 START, 32 truncated stdout ACTIVITY
// `step_start` lines, 36 stderr ACTIVITY lines, 1 INTERRUPTED.
const MISSION_095_PROGRESS_LOG = String.raw`2026-10-17T12:46:04+03:00  START | ROLE=planner | PHASE=1 | TASK=standalone-planning-planner | ATTEMPT=0 | PID=-
2026-10-17T12:46:06+03:00  START | ROLE=planner | PHASE=1 | TASK=standalone-planning-planner | ATTEMPT=0 | PID=11291
2026-10-17T12:46:10+03:00  ACTIVITY | STREAM=stderr | BYTES=140 | LAST=timestamp=2026-10-17T09:46:10.022Z level=INFO run=004e5f83 message="creating instance" directory=/home/user/projects/project-autopilot-dev
2026-10-17T12:46:11+03:00  ACTIVITY | STREAM=stderr | BYTES=148 | LAST=timestamp=2026-10-17T09:46:11.040Z level=INFO run=004e5f83 message=loading path=/home/user/projects/project-autopilot-dev/.opencode/opencode.jsonc
2026-10-17T12:46:12+03:00  ACTIVITY | STREAM=stderr | BYTES=767 | LAST=timestamp=2026-10-17T09:46:12.275Z level=INFO run=004e5f83 message=created id=ses_eb6becc4dffeFCHF889K9c0cOx slug=eager-otter version=1.18.35 projectID=e4e6bb81941837eb75cbd127d11486e6556d52f9 directory=/home/user/projects/project-autopilot-dev path="" workspaceID=undefined parentID=undefined title="New session - 2026-10-17T09:46:12.275Z" agent=undefined model=undefined metadata=undefined permission="[{\"permission\":\"question\",\"pattern\":\"*\",\"action\":\"deny\"},{\"permission\":\"plan_enter\",\"pattern\":\"*\",\"action\":\"deny\"},{\"permission\":\"plan_exit\",\"pattern\":\"*\",\"actio…
2026-10-17T12:46:15+03:00  ACTIVITY | STREAM=stderr | BYTES=121 | LAST=timestamp=2026-10-17T09:46:15.167Z level=INFO run=004e5f83 message=loop session.id=ses_eb6becc4dffeFCHF889K9c0cOx step=0
2026-10-17T12:46:16+03:00  ACTIVITY | STREAM=stderr | BYTES=169 | LAST=timestamp=2026-10-17T09:46:16.278Z level=INFO run=004e5f83 message="watcher backend" directory=/home/user/projects/project-autopilot-dev platform=linux backend=inotify
2026-10-17T12:46:18+03:00  ACTIVITY | STREAM=stderr | BYTES=168 | LAST=timestamp=2026-10-17T09:46:18.260Z level=INFO run=004e5f83 message="project copy refresh done" projectID=e4e6bb81941837eb75cbd127d11486e6556d52f9 updated=[] removed=[]
2026-10-17T12:46:20+03:00  ACTIVITY | STREAM=stdout | BYTES=250 | LAST={"type":"step_start","timestamp":1792230380791,"sessionID":"ses_eb6becc4dffeFCHF889K9c0cOx","part":{"id":"prt_1494154da0012ObmExerxPx406","messageID":"msg_149413f09001KN5rI2mCZXiQsl","sessionID":"ses_eb6becc4dffeFCHF889K9c0cOx","type":"step-start"}}
2026-10-17T12:46:21+03:00  ACTIVITY | STREAM=stderr | BYTES=238 | LAST=timestamp=2026-10-17T09:46:21.901Z level=INFO run=004e5f83 message="resolved path" arg=/home/user/projects/project-autopilot-dev/.autopilot/tasks/backlog.md resolved=/home/user/projects/project-autopilot-dev/.autopilot/tasks/backlog.md
2026-10-17T12:46:24+03:00  ACTIVITY | STREAM=stdout | BYTES=250 | LAST={"type":"step_start","timestamp":1792230384490,"sessionID":"ses_eb6becc4dffeFCHF889K9c0cOx","part":{"id":"prt_149416359001jvBX03X6CUA50d","messageID":"msg_149415a38001C0upUdn4WCx8KO","sessionID":"ses_eb6becc4dffeFCHF889K9c0cOx","type":"step-start"}}
2026-10-17T12:46:25+03:00  ACTIVITY | STREAM=stderr | BYTES=283 | LAST=timestamp=2026-10-17T09:46:25.597Z level=INFO run=004e5f83 message=evaluated permission=external_directory pattern=/home/user/.local/share/opencode/tool-output/* action.permission=external_directory action.pattern=/home/user/.local/share/opencode/tool-output/* action.action=allow
2026-10-17T12:46:28+03:00  ACTIVITY | STREAM=stdout | BYTES=250 | LAST={"type":"step_start","timestamp":1792230388123,"sessionID":"ses_eb6becc4dffeFCHF889K9c0cOx","part":{"id":"prt_14941715d001r73a64py852T3n","messageID":"msg_14941695f001CT6x4fMQ608l0d","sessionID":"ses_eb6becc4dffeFCHF889K9c0cOx","type":"step-start"}}
2026-10-17T12:46:29+03:00  ACTIVITY | STREAM=stderr | BYTES=182 | LAST=timestamp=2026-10-17T09:46:29.647Z level=INFO run=004e5f83 message="resolved path" arg=/home/user/projects/project-autopilot-dev resolved=/home/user/projects/project-autopilot-dev
2026-10-17T12:46:32+03:00  ACTIVITY | STREAM=stdout | BYTES=250 | LAST={"type":"step_start","timestamp":1792230392466,"sessionID":"ses_eb6becc4dffeFCHF889K9c0cOx","part":{"id":"prt_149418265001S6T13cLjoIC6UN","messageID":"msg_14941789c001SJddpfyUKEXJLI","sessionID":"ses_eb6becc4dffeFCHF889K9c0cOx","type":"step-start"}}
2026-10-17T12:46:33+03:00  ACTIVITY | STREAM=stderr | BYTES=182 | LAST=timestamp=2026-10-17T09:46:33.531Z level=INFO run=004e5f83 message="resolved path" arg=/home/user/projects/project-autopilot-dev resolved=/home/user/projects/project-autopilot-dev
2026-10-17T12:46:36+03:00  ACTIVITY | STREAM=stdout | BYTES=250 | LAST={"type":"step_start","timestamp":1792230396173,"sessionID":"ses_eb6becc4dffeFCHF889K9c0cOx","part":{"id":"prt_1494190f4001FwTux3PQiCeDX1","messageID":"msg_149418825001vpFS0eunvliu8s","sessionID":"ses_eb6becc4dffeFCHF889K9c0cOx","type":"step-start"}}
2026-10-17T12:46:37+03:00  ACTIVITY | STREAM=stderr | BYTES=121 | LAST=timestamp=2026-10-17T09:46:37.237Z level=INFO run=004e5f83 message=loop session.id=ses_eb6becc4dffeFCHF889K9c0cOx step=5
2026-10-17T12:46:41+03:00  ACTIVITY | STREAM=stdout | BYTES=250 | LAST={"type":"step_start","timestamp":1792230401153,"sessionID":"ses_eb6becc4dffeFCHF889K9c0cOx","part":{"id":"prt_14941a448001NpMK2LKMb31DNW","messageID":"msg_14941953b001h5vKGkUV0UQIgF","sessionID":"ses_eb6becc4dffeFCHF889K9c0cOx","type":"step-start"}}
2026-10-17T12:46:43+03:00  ACTIVITY | STREAM=stderr | BYTES=240 | LAST=timestamp=2026-10-17T09:46:43.012Z level=INFO run=004e5f83 message=evaluated permission=read pattern=.autopilot/missions/095-home-linux-projects/runs/01-planner-8dc646d0/brief.txt action.permission=read action.pattern=* action.action=allow
2026-10-17T12:46:45+03:00  ACTIVITY | STREAM=stdout | BYTES=250 | LAST={"type":"step_start","timestamp":1792230405544,"sessionID":"ses_eb6becc4dffeFCHF889K9c0cOx","part":{"id":"prt_14941b533001k8XNYv1d2fc6xL","messageID":"msg_14941ac8c0012ATkiaOxGYs0gT","sessionID":"ses_eb6becc4dffeFCHF889K9c0cOx","type":"step-start"}}
2026-10-17T12:46:49+03:00  ACTIVITY | STREAM=stderr | BYTES=182 | LAST=timestamp=2026-10-17T09:46:49.438Z level=INFO run=004e5f83 message="resolved path" arg=/home/user/projects/project-autopilot-dev resolved=/home/user/projects/project-autopilot-dev
2026-10-17T12:46:52+03:00  ACTIVITY | STREAM=stdout | BYTES=250 | LAST={"type":"step_start","timestamp":1792230412227,"sessionID":"ses_eb6becc4dffeFCHF889K9c0cOx","part":{"id":"prt_14941cfb8001uYxRpX4wwCuBfi","messageID":"msg_14941c55d0016s1Xv3eaK39aMK","sessionID":"ses_eb6becc4dffeFCHF889K9c0cOx","type":"step-start"}}
2026-10-17T12:46:57+03:00  ACTIVITY | STREAM=stderr | BYTES=182 | LAST=timestamp=2026-10-17T09:46:57.976Z level=INFO run=004e5f83 message="resolved path" arg=/home/user/projects/project-autopilot-dev resolved=/home/user/projects/project-autopilot-dev
2026-10-17T12:47:00+03:00  ACTIVITY | STREAM=stdout | BYTES=250 | LAST={"type":"step_start","timestamp":1792230420430,"sessionID":"ses_eb6becc4dffeFCHF889K9c0cOx","part":{"id":"prt_14941efc10010sRF6GtUL29zsx","messageID":"msg_14941e6dc001PY0A0VN3txMCmy","sessionID":"ses_eb6becc4dffeFCHF889K9c0cOx","type":"step-start"}}
2026-10-17T12:47:02+03:00  ACTIVITY | STREAM=stderr | BYTES=182 | LAST=timestamp=2026-10-17T09:47:02.675Z level=INFO run=004e5f83 message="resolved path" arg=/home/user/projects/project-autopilot-dev resolved=/home/user/projects/project-autopilot-dev
2026-10-17T12:47:14+03:00  ACTIVITY | STREAM=stderr | BYTES=121 | LAST=timestamp=2026-10-17T09:47:14.734Z level=INFO run=004e5f83 message=loop session.id=ses_eb6becc4dffeFCHF889K9c0cOx step=9
2026-10-17T12:47:18+03:00  ACTIVITY | STREAM=stdout | BYTES=250 | LAST={"type":"step_start","timestamp":1792230438043,"sessionID":"ses_eb6becc4dffeFCHF889K9c0cOx","part":{"id":"prt_14942348b00183ITpzZA2JEQAs","messageID":"msg_1494227ba0016QzOI3ZR8EyHu0","sessionID":"ses_eb6becc4dffeFCHF889K9c0cOx","type":"step-start"}}
2026-10-17T12:47:20+03:00  ACTIVITY | STREAM=stderr | BYTES=182 | LAST=timestamp=2026-10-17T09:47:20.103Z level=INFO run=004e5f83 message="resolved path" arg=/home/user/projects/project-autopilot-dev resolved=/home/user/projects/project-autopilot-dev
2026-10-17T12:47:23+03:00  ACTIVITY | STREAM=stdout | BYTES=250 | LAST={"type":"step_start","timestamp":1792230443306,"sessionID":"ses_eb6becc4dffeFCHF889K9c0cOx","part":{"id":"prt_149424925001ECfFtEg9PuubGo","messageID":"msg_149423d970015bQffXZktR4EjH","sessionID":"ses_eb6becc4dffeFCHF889K9c0cOx","type":"step-start"}}
2026-10-17T12:47:27+03:00  ACTIVITY | STREAM=stderr | BYTES=182 | LAST=timestamp=2026-10-17T09:47:27.795Z level=INFO run=004e5f83 message="resolved path" arg=/home/user/projects/project-autopilot-dev resolved=/home/user/projects/project-autopilot-dev
2026-10-17T12:47:30+03:00  ACTIVITY | STREAM=stdout | BYTES=250 | LAST={"type":"step_start","timestamp":1792230450985,"sessionID":"ses_eb6becc4dffeFCHF889K9c0cOx","part":{"id":"prt_149426724001WOysjuLvijEMDq","messageID":"msg_149425b03001eBZqW8q9mLv8Fo","sessionID":"ses_eb6becc4dffeFCHF889K9c0cOx","type":"step-start"}}
2026-10-17T12:47:41+03:00  ACTIVITY | STREAM=stderr | BYTES=184 | LAST=timestamp=2026-10-17T09:47:41.656Z level=INFO run=004e5f83 message=evaluated permission=read pattern=.autopilot/config.json action.permission=read action.pattern=* action.action=allow
2026-10-17T12:47:45+03:00  ACTIVITY | STREAM=stdout | BYTES=250 | LAST={"type":"step_start","timestamp":1792230465344,"sessionID":"ses_eb6becc4dffeFCHF889K9c0cOx","part":{"id":"prt_149429f35001BsWU0yiPix7hK1","messageID":"msg_14942916e001Hu8lZtVdbmkUAM","sessionID":"ses_eb6becc4dffeFCHF889K9c0cOx","type":"step-start"}}
2026-10-17T12:47:47+03:00  ACTIVITY | STREAM=stderr | BYTES=182 | LAST=timestamp=2026-10-17T09:47:47.636Z level=INFO run=004e5f83 message="resolved path" arg=/home/user/projects/project-autopilot-dev resolved=/home/user/projects/project-autopilot-dev
2026-10-17T12:47:50+03:00  ACTIVITY | STREAM=stdout | BYTES=250 | LAST={"type":"step_start","timestamp":1792230470250,"sessionID":"ses_eb6becc4dffeFCHF889K9c0cOx","part":{"id":"prt_14942b251001W2gTb9mlEOjpug","messageID":"msg_14942a8b3001HbN6FXIC5msYHv","sessionID":"ses_eb6becc4dffeFCHF889K9c0cOx","type":"step-start"}}
2026-10-17T12:47:51+03:00  ACTIVITY | STREAM=stderr | BYTES=158 | LAST=timestamp=2026-10-17T09:47:51.371Z level=INFO run=004e5f83 message=process session.id=ses_eb6becc4dffeFCHF889K9c0cOx messageID=msg_14942b607001P6Vp8dFamQ7sxt
2026-10-17T12:47:55+03:00  ACTIVITY | STREAM=stdout | BYTES=250 | LAST={"type":"step_start","timestamp":1792230475007,"sessionID":"ses_eb6becc4dffeFCHF889K9c0cOx","part":{"id":"prt_14942c4ee001YHR2unsq5Z5vF8","messageID":"msg_14942b607001P6Vp8dFamQ7sxt","sessionID":"ses_eb6becc4dffeFCHF889K9c0cOx","type":"step-start"}}
2026-10-17T12:48:00+03:00  ACTIVITY | STREAM=stderr | BYTES=182 | LAST=timestamp=2026-10-17T09:48:00.219Z level=INFO run=004e5f83 message="resolved path" arg=/home/user/projects/project-autopilot-dev resolved=/home/user/projects/project-autopilot-dev
2026-10-17T12:48:07+03:00  ACTIVITY | STREAM=stdout | BYTES=250 | LAST={"type":"step_start","timestamp":1792230487932,"sessionID":"ses_eb6becc4dffeFCHF889K9c0cOx","part":{"id":"prt_14942f777001t0Pgwzo4140bFj","messageID":"msg_14942d9fe001ZZcZ7d1ihO1A54","sessionID":"ses_eb6becc4dffeFCHF889K9c0cOx","type":"step-start"}}
2026-10-17T12:48:16+03:00  ACTIVITY | STREAM=stderr | BYTES=182 | LAST=timestamp=2026-10-17T09:48:16.875Z level=INFO run=004e5f83 message="resolved path" arg=/home/user/projects/project-autopilot-dev resolved=/home/user/projects/project-autopilot-dev
2026-10-17T12:48:20+03:00  ACTIVITY | STREAM=stdout | BYTES=250 | LAST={"type":"step_start","timestamp":1792230500279,"sessionID":"ses_eb6becc4dffeFCHF889K9c0cOx","part":{"id":"prt_1494327ab001w74hcVFwmq5wF4","messageID":"msg_149431adb001G2L3Q2ALSdkOpb","sessionID":"ses_eb6becc4dffeFCHF889K9c0cOx","type":"step-start"}}
2026-10-17T12:48:31+03:00  ACTIVITY | STREAM=stderr | BYTES=182 | LAST=timestamp=2026-10-17T09:48:31.556Z level=INFO run=004e5f83 message="resolved path" arg=/home/user/projects/project-autopilot-dev resolved=/home/user/projects/project-autopilot-dev
2026-10-17T12:48:34+03:00  ACTIVITY | STREAM=stdout | BYTES=250 | LAST={"type":"step_start","timestamp":1792230514929,"sessionID":"ses_eb6becc4dffeFCHF889K9c0cOx","part":{"id":"prt_1494360e2001sCuywPBsKrZiVh","messageID":"msg_14943542a0013LpFJ35sPlIIuZ","sessionID":"ses_eb6becc4dffeFCHF889K9c0cOx","type":"step-start"}}
2026-10-17T12:48:38+03:00  ACTIVITY | STREAM=stderr | BYTES=182 | LAST=timestamp=2026-10-17T09:48:38.170Z level=INFO run=004e5f83 message="resolved path" arg=/home/user/projects/project-autopilot-dev resolved=/home/user/projects/project-autopilot-dev
2026-10-17T12:48:41+03:00  ACTIVITY | STREAM=stdout | BYTES=250 | LAST={"type":"step_start","timestamp":1792230521489,"sessionID":"ses_eb6becc4dffeFCHF889K9c0cOx","part":{"id":"prt_149437a8c001BzszLMm463HNnh","messageID":"msg_149436e62001SaPCOyneESug3c","sessionID":"ses_eb6becc4dffeFCHF889K9c0cOx","type":"step-start"}}
2026-10-17T12:48:48+03:00  ACTIVITY | STREAM=stderr | BYTES=182 | LAST=timestamp=2026-10-17T09:48:48.939Z level=INFO run=004e5f83 message="resolved path" arg=/home/user/projects/project-autopilot-dev resolved=/home/user/projects/project-autopilot-dev
2026-10-17T12:48:52+03:00  ACTIVITY | STREAM=stdout | BYTES=250 | LAST={"type":"step_start","timestamp":1792230532104,"sessionID":"ses_eb6becc4dffeFCHF889K9c0cOx","part":{"id":"prt_14943a3fa001vcJT6mZz33nbjg","messageID":"msg_149439831001cCmSuSdKbpUqXC","sessionID":"ses_eb6becc4dffeFCHF889K9c0cOx","type":"step-start"}}
2026-10-17T12:48:53+03:00  ACTIVITY | STREAM=stderr | BYTES=122 | LAST=timestamp=2026-10-17T09:48:53.176Z level=INFO run=004e5f83 message=loop session.id=ses_eb6becc4dffeFCHF889K9c0cOx step=20
2026-10-17T12:48:57+03:00  ACTIVITY | STREAM=stdout | BYTES=250 | LAST={"type":"step_start","timestamp":1792230537138,"sessionID":"ses_eb6becc4dffeFCHF889K9c0cOx","part":{"id":"prt_14943b7ae001VsR3WNUWSdd0L1","messageID":"msg_14943a840001cre6KsmzVz44yc","sessionID":"ses_eb6becc4dffeFCHF889K9c0cOx","type":"step-start"}}
2026-10-17T12:49:16+03:00  ACTIVITY | STREAM=stderr | BYTES=188 | LAST=timestamp=2026-10-17T09:49:16.671Z level=INFO run=004e5f83 message=evaluated permission=read pattern=.autopilot/tasks/config.md action.permission=read action.pattern=* action.action=allow
2026-10-17T12:49:20+03:00  ACTIVITY | STREAM=stdout | BYTES=250 | LAST={"type":"step_start","timestamp":1792230560312,"sessionID":"ses_eb6becc4dffeFCHF889K9c0cOx","part":{"id":"prt_149441228001gUehkue6MnH5L8","messageID":"msg_149440489001sCkutPm0fqX82S","sessionID":"ses_eb6becc4dffeFCHF889K9c0cOx","type":"step-start"}}
2026-10-17T12:49:28+03:00  ACTIVITY | STREAM=stderr | BYTES=182 | LAST=timestamp=2026-10-17T09:49:28.113Z level=INFO run=004e5f83 message="resolved path" arg=/home/user/projects/project-autopilot-dev resolved=/home/user/projects/project-autopilot-dev
2026-10-17T12:49:32+03:00  ACTIVITY | STREAM=stdout | BYTES=250 | LAST={"type":"step_start","timestamp":1792230572159,"sessionID":"ses_eb6becc4dffeFCHF889K9c0cOx","part":{"id":"prt_14944407a001dlqAJThPDOKhX6","messageID":"msg_14944313200191etR8eQIp4Shz","sessionID":"ses_eb6becc4dffeFCHF889K9c0cOx","type":"step-start"}}
2026-10-17T12:49:33+03:00  ACTIVITY | STREAM=stderr | BYTES=182 | LAST=timestamp=2026-10-17T09:49:33.193Z level=INFO run=004e5f83 message="resolved path" arg=/home/user/projects/project-autopilot-dev resolved=/home/user/projects/project-autopilot-dev
2026-10-17T12:49:36+03:00  ACTIVITY | STREAM=stdout | BYTES=250 | LAST={"type":"step_start","timestamp":1792230576425,"sessionID":"ses_eb6becc4dffeFCHF889K9c0cOx","part":{"id":"prt_149445125001VycTcjV3bYD2r4","messageID":"msg_1494444dc001fnKvejiu4rq29u","sessionID":"ses_eb6becc4dffeFCHF889K9c0cOx","type":"step-start"}}
2026-10-17T12:49:39+03:00  ACTIVITY | STREAM=stdout | BYTES=250 | LAST={"type":"step_start","timestamp":1792230579880,"sessionID":"ses_eb6becc4dffeFCHF889K9c0cOx","part":{"id":"prt_149445ea2001zZULR2qAV9poj5","messageID":"msg_1494452dd001cyD3lYyGGY13ab","sessionID":"ses_eb6becc4dffeFCHF889K9c0cOx","type":"step-start"}}
2026-10-17T12:49:42+03:00  ACTIVITY | STREAM=stderr | BYTES=182 | LAST=timestamp=2026-10-17T09:49:42.435Z level=INFO run=004e5f83 message="resolved path" arg=/home/user/projects/project-autopilot-dev resolved=/home/user/projects/project-autopilot-dev
2026-10-17T12:49:45+03:00  ACTIVITY | STREAM=stdout | BYTES=250 | LAST={"type":"step_start","timestamp":1792230585872,"sessionID":"ses_eb6becc4dffeFCHF889K9c0cOx","part":{"id":"prt_14944760200104R6L7Zpj0wd64","messageID":"msg_14944697c001jyWc72DMTRdprr","sessionID":"ses_eb6becc4dffeFCHF889K9c0cOx","type":"step-start"}}
2026-10-17T12:49:54+03:00  ACTIVITY | STREAM=stderr | BYTES=191 | LAST=timestamp=2026-10-17T09:49:54.365Z level=INFO run=004e5f83 message=evaluated permission=read pattern=scripts/config-validation.mjs action.permission=read action.pattern=* action.action=allow
2026-10-17T12:49:58+03:00  ACTIVITY | STREAM=stdout | BYTES=250 | LAST={"type":"step_start","timestamp":1792230598417,"sessionID":"ses_eb6becc4dffeFCHF889K9c0cOx","part":{"id":"prt_14944a70d001lMk4i1au3rKcX2","messageID":"msg_149449773001c6tWI23UOkYS5S","sessionID":"ses_eb6becc4dffeFCHF889K9c0cOx","type":"step-start"}}
2026-10-17T12:50:02+03:00  ACTIVITY | STREAM=stderr | BYTES=182 | LAST=timestamp=2026-10-17T09:50:02.559Z level=INFO run=004e5f83 message="resolved path" arg=/home/user/projects/project-autopilot-dev resolved=/home/user/projects/project-autopilot-dev
2026-10-17T12:50:07+03:00  ACTIVITY | STREAM=stdout | BYTES=250 | LAST={"type":"step_start","timestamp":1792230607590,"sessionID":"ses_eb6becc4dffeFCHF889K9c0cOx","part":{"id":"prt_14944cad7001rcJDTflw1500oG","messageID":"msg_14944b7c30015TDF7J2cHrtdu7","sessionID":"ses_eb6becc4dffeFCHF889K9c0cOx","type":"step-start"}}
2026-10-17T12:50:08+03:00  ACTIVITY | STREAM=stderr | BYTES=158 | LAST=timestamp=2026-10-17T09:50:08.659Z level=INFO run=004e5f83 message=process session.id=ses_eb6becc4dffeFCHF889K9c0cOx messageID=msg_14944ce58001TXoEMZOQRV3VMC
2026-10-17T12:50:13+03:00  ACTIVITY | STREAM=stdout | BYTES=250 | LAST={"type":"step_start","timestamp":1792230613120,"sessionID":"ses_eb6becc4dffeFCHF889K9c0cOx","part":{"id":"prt_14944e078001t1KasG2N8d4m3z","messageID":"msg_14944ce58001TXoEMZOQRV3VMC","sessionID":"ses_eb6becc4dffeFCHF889K9c0cOx","type":"step-start"}}
2026-10-17T12:50:30+03:00  ACTIVITY | STREAM=stderr | BYTES=182 | LAST=timestamp=2026-10-17T09:50:30.771Z level=INFO run=004e5f83 message="resolved path" arg=/home/user/projects/project-autopilot-dev resolved=/home/user/projects/project-autopilot-dev
2026-10-17T12:50:34+03:00  ACTIVITY | STREAM=stdout | BYTES=250 | LAST={"type":"step_start","timestamp":1792230634832,"sessionID":"ses_eb6becc4dffeFCHF889K9c0cOx","part":{"id":"prt_1494535390016LltX76DwxpEau","messageID":"msg_1494525c0001QV5INFrRLtJQ1e","sessionID":"ses_eb6becc4dffeFCHF889K9c0cOx","type":"step-start"}}
2026-10-17T12:50:35+03:00  ACTIVITY | STREAM=stderr | BYTES=122 | LAST=timestamp=2026-10-17T09:50:35.890Z level=INFO run=004e5f83 message=loop session.id=ses_eb6becc4dffeFCHF889K9c0cOx step=30
2026-10-17T12:50:39+03:00  ACTIVITY | STREAM=stdout | BYTES=250 | LAST={"type":"step_start","timestamp":1792230639923,"sessionID":"ses_eb6becc4dffeFCHF889K9c0cOx","part":{"id":"prt_1494549270018v5LGzNN1HUmDN","messageID":"msg_149453983001znxRWknR4Zvz8D","sessionID":"ses_eb6becc4dffeFCHF889K9c0cOx","type":"step-start"}}
2026-10-17T12:50:44+03:00  ACTIVITY | STREAM=stdout | BYTES=250 | LAST={"type":"step_start","timestamp":1792230644352,"sessionID":"ses_eb6becc4dffeFCHF889K9c0cOx","part":{"id":"prt_149455a75001aPW7FjNWEY9i4G","messageID":"msg_149454bd7001puU1SOdjaziZCl","sessionID":"ses_eb6becc4dffeFCHF889K9c0cOx","type":"step-start"}}
2026-10-17T12:50:47+03:00  INTERRUPTED | STATUS=interrupted | REASON=received SIGTERM | AT=2026-10-17T12:50:47+03:00`;

const failures = [];
const check = (name, cond, extra) => {
  if (cond) console.log(`PASS ${name}`);
  else { failures.push(name); console.error(`FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ""}`); }
};

const run = (o) => ({ status: "completed", decision: null, findings: [], ...o });

const PHASES = [
  { number: 1, name: "Phase 1 — Reproduce and locate", done: true, tasks: [{ text: "T1.1", done: true }] },
  { number: 2, name: "Phase 2 — Narrow the fingerprint exclusion", done: false, tasks: [{ text: "T2.1", done: false }] },
  { number: 3, name: "Phase 3 — Regression test and suite green", done: false, tasks: [{ text: "T3.1", done: false }] },
];
const POLICY = {
  max_plan_revisions: 8, final_review_fix_rounds: 2, continuation_allowance: 5,
  failure_budgets: { implementationFailureBudget: 3, verificationFailureBudget: 3, adapterRetryBudget: 2, infrastructureRetryBudget: 2 },
  caps: { planner: { max_tokens: 750000 }, plan_reviewer: { max_tokens: 300000 }, implementer: { max_tokens: 500000 }, code_reviewer: { max_tokens: 300000 }, verifier: { max_tokens: 500000 } },
};

// ── 1. the watcher.md Example CURRENT RUN + LIVE PROGRESS (mission 021) ─────
{
  const state = {
    mission: "021-fix-backlog-item", phase: "implementing", step: "implement", phaseIndex: 1, attempt: 2,
    planningStartedAt: "2026-09-28T23:38:26+03:00", planningDetection: { framework: "standalone" },
    failureBudgets: { "verificationFailureBudget:task:T2.1": 1 },
  };
  const runs = [
    run({ id: "10-implementer-7f2a91e0", role: "implementer", phase: "2", attempt: "1", taskRef: "T2.1", resolvedModel: "claude-muse-spark-1.3", started_at: "2026-09-29T00:33:21+03:00", usage: { priceWeighted: 32500, turns: 5, peakContext: 20400 } }),
    run({ id: "10b-verifier-7f2a91e0", role: "verifier", phase: "2", attempt: "1", taskRef: "T2.1", decision: "FAIL", started_at: "2026-09-29T01:00:00+03:00" }),
    run({
      id: "17-implementer-db4d1811", role: "implementer", phase: "2", attempt: "2", taskRef: "T2.3",
      status: "running", sessionNumber: 1, resolvedModel: "claude-muse-spark-1.3", pid: 81234,
      started_at: "2026-09-29T01:41:55+03:00", updated_at: "2026-09-29T01:48:22+03:00",
      snapshotBeforeAt: "2026-09-29T01:44:02+03:00", note: "finding 1",
      usage: { priceWeighted: 52000, turns: 9, peakContext: 27300 },
    }),
  ];
  const events = [
    { type: "prep", role: "implementer", phase: 2, taskRef: "T2.3", attempt: 2, at: "2026-09-29T01:41:55+03:00" },
    { type: "start", role: "implementer", phase: 2, taskRef: "T2.3", attempt: 2, pid: 81234, at: "2026-09-29T01:44:02+03:00" },
    { type: "warn", text: "⚠ ProviderHeaderTimeout (transient, opencode retrying)", at: "2026-09-29T01:45:02+03:00" },
  ];
  const progress = [
    `2026-09-29T01:44:27+03:00  ACTIVITY | LAST={"part":{"type":"tool","tool":"bash","state":{"input":{"command":"git status --porcelain | head -n 50"}}}}`,
    `2026-09-29T01:44:30+03:00  ACTIVITY | LAST={"part":{"type":"step_start"}}`,
  ];
  const now = "2026-09-29T01:48:30+03:00";
  const model = buildReportModel({ state, runs, events, phases: PHASES, policy: POLICY, progress, now });
  const report = renderReport(model, { stamp: "2026-09-29 01:48:30" });
  const current = renderCurrentRun(model);
  const live = renderLiveProgress(model);
  const has = (name, frag) => check(`example: ${name}`, report.includes(frag), frag);

  has("current run header", "=== CURRENT RUN ===");
  has("stage line", "stage:   IMPLEMENTATION · Phase 2/3 · attempt 2");
  has("run line", "run:     17-implementer-db4d1811");
  has("role line", "role:    implementer · task T2.3 · model muse-spark-1.3 · session 1 of 6");
  has("status line", "status:  RUNNING · pid 81234 (alive)");
  has("started line", "started: 2026-09-29 01:41:55 · elapsed 00:06:35 (pre-run snapshot 2:07)");
  has("last activity line", "last activity: 2026-09-29 01:48:22 (8s ago)");
  has("usage line", "usage so far: ~52.0K of 500K cap · context ~27.3K · 9 turns");

  has("live header", "=== LIVE PROGRESS (last 10 actions) ===");
  has("live PREP", "2026-09-29 01:41:55  PREP    role=implementer · phase=2 · TASK=T2.3 · attempt=2 · pre-run snapshot started");
  has("live START", "2026-09-29 01:44:02  START   role=implementer · phase=2 · TASK=T2.3 · attempt=2 · pid=81234");
  has("live WARN", "2026-09-29 01:45:02  WARN    ⚠ ProviderHeaderTimeout (transient, opencode retrying)");
  has("live decoded tool line", "bash    git status --porcelain | head -n 50");

  // rule 5: the current-run numbers match the run's table row
  check("example: price matches row", current.includes("~52.0K") && report.includes("~52.0K"));
  check("example: context matches row", current.includes("context ~27.3K"));
  check("example: turns match row", current.includes("9 turns"));

  // rule 6: no raw JSON / streaming noise
  check("example: no raw JSON in report", !/\{\s*"/.test(report), report);
  check("example: streaming noise dropped", !report.includes("step_start"), report);
  check("example: live has no raw JSON", !/\{\s*"/.test(live), live);
  check("example: no trailing whitespace", report.split("\n").every((l) => l === l.replace(/\s+$/, "")));
  check("example: current section is standalone block", current.startsWith("=== CURRENT RUN ===\n") && !current.includes("PIPELINE STATE"));
  check("example: live section is standalone block", live.startsWith("=== LIVE PROGRESS (last 10 actions) ==="));

  const curIdx = report.indexOf("=== CURRENT RUN ===");
  const liveIdx = report.indexOf("=== LIVE PROGRESS (last 10 actions) ===");
  check("example: CURRENT RUN before LIVE PROGRESS", curIdx > 0 && liveIdx > curIdx, curIdx);
  check("example: sections follow the final-review block", report.indexOf("=== FINAL REVIEW STAGE ===") < curIdx);
}

// ── 2. orchestrator-gate running variant (watcher.md gate example) ──────────
{
  const state = {
    mission: "021-fix-backlog-item", phase: "implementing", step: "gate", phaseIndex: 1, attempt: 2,
    planningStartedAt: "2026-09-29T00:00:00+03:00", planningDetection: { framework: "standalone" },
  };
  const runs = [
    run({ id: "10-implementer-7f2a91e0", role: "implementer", phase: "2", attempt: "1", taskRef: "T2.1", resolvedModel: "claude-muse-spark-1.3", started_at: "2026-09-29T00:43:24+03:00", usage: { priceWeighted: 32500, turns: 5, peakContext: 20400 } }),
    run({ id: "10b-verifier-7f2a91e0", role: "verifier", phase: "2", attempt: "1", taskRef: "T2.1", decision: "FAIL", started_at: "2026-09-29T00:50:00+03:00" }),
    run({ id: "16-implementer-3ebe846e", role: "implementer", phase: "2", attempt: "2", taskRef: "T2.3", resolvedModel: "claude-muse-spark-1.3", started_at: "2026-09-29T01:36:40+03:00", usage: { priceWeighted: 32500, turns: 5, peakContext: 20400 } }),
  ];
  const events = [
    { type: "gate_start", phase: 2, command: "node scripts/test-all.mjs --skip-live", scripts: 185, runs: 204, pid: 82011, at: "2026-09-29T02:01:10+03:00" },
    { type: "gate_progress", phase: 2, command: "node scripts/test-all.mjs --skip-live", passed: 96, total: 204, failed: 0, at: "2026-09-29T02:08:52+03:00" },
  ];
  const now = "2026-09-29T02:08:52+03:00";
  const model = buildReportModel({ state, runs, events, phases: PHASES, policy: POLICY, now });
  const report = renderReport(model, { stamp: "2026-09-29 02:08:52" });
  const has = (name, frag) => check(`gate: ${name}`, report.includes(frag), frag);

  check("gate: current is the gate", model.current && model.current.kind === "gate", model.current);

  has("current header", "=== CURRENT RUN ===");
  has("stage line", "stage:   IMPLEMENTATION · Phase 2/3 · attempt 2");
  has("run line", "run:     GATE (orchestrator full suite, no agent)");
  has("command line", "command: node scripts/test-all.mjs --skip-live");
  has("status line", "status:  RUNNING · pid 82011 (alive)");
  has("started line", "started: 2026-09-29 02:01:10 · elapsed 00:07:42");
  has("progress line", "progress: 96/204 runs · 96 passed · 0 failed");
  has("live gate start", "GATE    orchestrator started the full test suite · node scripts/test-all.mjs --skip-live · 185 scripts in 204 runs");
  has("live gate progress", "GATE    full test suite 96/204 runs · 0 failed");

  check("gate: no raw JSON", !/\{\s*"/.test(report), report);
  check("gate: no run role line", !report.includes("role:    GATE"), report);
}

// ── 3. live-only: a completed mission shows no CURRENT RUN ──────────────────
{
  const state = { mission: "021-fix-backlog-item", phase: "complete", step: "done", planningDetection: { framework: "standalone" } };
  const model = buildReportModel({ state, runs: [], events: [], phases: PHASES, policy: POLICY, now: "2026-09-29T04:00:00+03:00" });
  const report = renderReport(model, { stamp: "2026-09-29 04:00:00" });
  check("completed: detectCurrent null", model.current === null, model.current);
  check("completed: renderCurrentRun empty", renderCurrentRun(model) === "", renderCurrentRun(model));
  check("completed: no CURRENT RUN section", !report.includes("=== CURRENT RUN ==="), report);
}

// ── 4. helpers / degradation ────────────────────────────────────────────────
{
  check("helper: renderLiveProgress empty", renderLiveProgress({ liveProgress: [] }) === "");
  check("helper: renderCurrentRun no current", renderCurrentRun({}) === "");
  check("helper: currentStageText planning", currentStageText({ stage: "PLANNING" }) === "PLANNING");
  check("helper: currentStageText final review", currentStageText({ stage: "FINAL REVIEW" }) === "FINAL REVIEW");
  check(
    "helper: currentStageText final review fix round",
    currentStageText({ stage: "FINAL REVIEW", policy: { final_review_fix_rounds: 2 }, finalReview: { fixRoundsUsed: 1 } }) === "FINAL REVIEW · fix round 1 of 2",
  );
  check(
    "helper: currentStageText implementation",
    currentStageText({ stage: "IMPLEMENTATION", phaseNumber: 2, attempt: 2, phases: [{}, {}, {}] }) === "IMPLEMENTATION · Phase 2/3 · attempt 2",
  );

  // a running run with no cap / no price degrades cleanly
  const state = { mission: "m", phase: "implementing", step: "implement", phaseIndex: 0, attempt: 1 };
  const running = run({ id: "01-implementer-abc", role: "implementer", phase: "1", attempt: "1", taskRef: "T1.1", status: "running", started_at: "2026-09-29T01:00:00+03:00" });
  const model = buildReportModel({ state, runs: [running], phases: [{ number: 1, name: "Phase 1", tasks: [] }], policy: {}, now: "2026-09-29T01:05:00+03:00" });
  const current = renderCurrentRun(model);
  check("degrade: usage not recorded", current.includes("usage so far: usage not recorded"), current);
  check("degrade: no crash, status running", current.includes("status:  RUNNING"), current);
}

// ── 5. mission 095 fixture (backlog #6) ─────────────────────────────────────
// The real 095 planner progress.log (embedded above): its only decodable
// signal for a live opencode run is the stderr `message=loop … step=N`
// heartbeat. Before the fix the tail the report reads decoded to zero entries,
// so the LIVE PROGRESS section was omitted entirely.
{
  const lines = MISSION_095_PROGRESS_LOG.split("\n").filter(Boolean);
  check("095: fixture has 71 lines", lines.length === 71, lines.length);

  const all = decodeLiveProgress({ progress: lines });
  check("095: full log decodes step heartbeats", all.some((e) => e.kind === "STEP" && e.text === "step 30"), all);
  check("095: no raw JSON survives", !all.some((e) => /\{\s*"/.test(e.text)), all);
  check("095: streaming step_start dropped", !all.some((e) => e.text.includes("step_start")), all);

  const tail = decodeLiveProgress({ progress: lines.slice(-40) });
  check("095: last 40 lines decode (regression: was 0)", tail.length > 0, tail);
  check("095: tail carries a step heartbeat", tail.some((e) => e.kind === "STEP"), tail);

  const state = {
    mission: "095-home-linux-projects", phase: "implementing", step: "run", phaseIndex: 0, attempt: 1,
    planningDetection: { framework: "standalone" },
  };
  const runs = [
    run({
      id: "01-planner-8dc646d0", dirName: "01-planner-8dc646d0", role: "planner", phase: "1", attempt: "0",
      taskRef: "standalone-planning-planner", planRevision: 0, status: "running", pid: 11291,
      started_at: "2026-10-17T12:46:06+03:00", updated_at: "2026-10-17T12:50:39+03:00",
      usage: { priceWeighted: 425000, turns: 31 },
    }),
  ];
  const model = buildReportModel({ state, runs, events: [], phases: [], policy: {}, progress: lines.slice(-40), now: "2026-10-17T12:50:45+03:00" });
  check("095: mission is live", model.status === "RUNNING" && !!model.current, { status: model.status, current: model.current });
  const report = renderReport(model, { stamp: "2026-10-17 12:50:45" });
  check("095: LIVE PROGRESS shown while live", report.includes("=== LIVE PROGRESS (last 10 actions) ==="), report.split("\n").find((l) => l.startsWith("=== LIVE")));
  check("095: heartbeat line rendered", /STEP\s+step 30/.test(report), report.split("\n").find((l) => l.includes("STEP")));

  // (c) a live run with no decoded action still shows the section.
  const emptyModel = buildReportModel({ state, runs, events: [], phases: [], policy: {}, progress: [], now: "2026-10-17T12:46:06+03:00" });
  const emptyLive = renderLiveProgress(emptyModel);
  check("095: live with no feed shows waiting line", emptyLive.includes("=== LIVE PROGRESS (last 10 actions) ===") && emptyLive.includes("waiting for the first action"), emptyLive);
  // A non-live mission with no feed stays omitted.
  check("095: dead mission with no feed omits section", renderLiveProgress({ status: "CANCELLED", current: null, liveProgress: [] }) === "");
}

if (failures.length) { console.error(`${failures.length} render-current check(s) failed.`); process.exit(1); }
console.log("All render-current checks passed.");
