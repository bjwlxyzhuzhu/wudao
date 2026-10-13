CREATE TABLE IF NOT EXISTS dance_profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(user_id), role TEXT NOT NULL CHECK(role IN ('student','teacher','medic')),
  cohort TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dance_standards (
  standard_id TEXT PRIMARY KEY, action_key TEXT NOT NULL, version INTEGER NOT NULL,
  cohort TEXT NOT NULL, teacher_id TEXT NOT NULL REFERENCES users(user_id), title TEXT NOT NULL,
  view TEXT NOT NULL, instructions TEXT NOT NULL, checkpoints TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(cohort,action_key,version)
);
CREATE TABLE IF NOT EXISTS dance_training (
  training_id TEXT PRIMARY KEY, student_id TEXT NOT NULL REFERENCES users(user_id), cohort TEXT NOT NULL,
  standard_id TEXT NOT NULL REFERENCES dance_standards(standard_id), status TEXT NOT NULL,
  idempotency_key TEXT NOT NULL, consent_teaching INTEGER NOT NULL, consent_cloud INTEGER NOT NULL,
  consent_video INTEGER NOT NULL, pose_json TEXT, metrics_json TEXT, analysis_json TEXT,
  video_path TEXT, video_type TEXT, video_expires_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(student_id,idempotency_key)
);
CREATE TABLE IF NOT EXISTS dance_feedback (
  feedback_id TEXT PRIMARY KEY, training_id TEXT NOT NULL REFERENCES dance_training(training_id),
  version INTEGER NOT NULL, teacher_id TEXT NOT NULL REFERENCES users(user_id), decision TEXT NOT NULL,
  strengths TEXT NOT NULL, priorities TEXT NOT NULL, next_drill TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(training_id,version)
);
CREATE INDEX IF NOT EXISTS ix_dance_training_student ON dance_training(student_id,created_at);
CREATE INDEX IF NOT EXISTS ix_dance_training_cohort ON dance_training(cohort,status);
CREATE TABLE IF NOT EXISTS dance_health (
  checkin_id TEXT PRIMARY KEY, student_id TEXT NOT NULL REFERENCES users(user_id), cohort TEXT NOT NULL,
  date TEXT NOT NULL, fatigue INTEGER NOT NULL, sleep_hours REAL NOT NULL, pain INTEGER NOT NULL,
  areas TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(student_id,date)
);
CREATE TABLE IF NOT EXISTS dance_loads (
  log_id TEXT PRIMARY KEY, student_id TEXT NOT NULL REFERENCES users(user_id), cohort TEXT NOT NULL,
  date TEXT NOT NULL, minutes INTEGER NOT NULL, rpe INTEGER NOT NULL, load REAL NOT NULL,
  idempotency_key TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(student_id,idempotency_key)
);
