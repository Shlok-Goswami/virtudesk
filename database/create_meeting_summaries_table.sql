-- Create meeting_summaries table if it doesn't exist
-- Run this in your Supabase SQL Editor

CREATE TABLE IF NOT EXISTS meeting_summaries (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  room_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  created_by TEXT,
  summary_text TEXT NOT NULL,
  key_points JSONB DEFAULT '[]'::jsonb,
  participants TEXT[] DEFAULT ARRAY[]::TEXT[],
  participant_names JSONB DEFAULT '{}'::jsonb,
  duration_ms BIGINT NOT NULL,
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ NOT NULL,
  transcriptions JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create index for faster queries by org_id
CREATE INDEX IF NOT EXISTS idx_meeting_summaries_org_id ON meeting_summaries(org_id);

-- Create index for faster queries by room_id
CREATE INDEX IF NOT EXISTS idx_meeting_summaries_room_id ON meeting_summaries(room_id);

-- Create index for faster queries by start_time (for ordering)
CREATE INDEX IF NOT EXISTS idx_meeting_summaries_start_time ON meeting_summaries(start_time DESC);

-- Add comments for documentation
COMMENT ON TABLE meeting_summaries IS 'Stores AI-generated meeting summaries with transcriptions and participant information';
COMMENT ON COLUMN meeting_summaries.room_id IS 'The room ID where the meeting took place';
COMMENT ON COLUMN meeting_summaries.org_id IS 'The organization ID that owns this meeting';
COMMENT ON COLUMN meeting_summaries.summary_text IS 'AI-generated summary of the meeting';
COMMENT ON COLUMN meeting_summaries.key_points IS 'Array of key points extracted from the meeting';
COMMENT ON COLUMN meeting_summaries.participants IS 'Array of participant user IDs';
COMMENT ON COLUMN meeting_summaries.participant_names IS 'JSON object mapping participant IDs to their display names';
COMMENT ON COLUMN meeting_summaries.transcriptions IS 'Array of transcription objects with id, name, and text';

