# Meeting Summary Workflow - End-to-End Verification

## Overview
This document explains the complete workflow for saving meeting summaries to Supabase and how to verify each step.

## Workflow Steps

### 1. Meeting Initialization
- **Function**: `Init(startTime: number)`
- **Location**: `app/actions/Summary.ts:194`
- **What it does**: Initializes the meeting start time and clears participant data
- **Called from**: MediaComponent when meeting starts

### 2. Participant Registration
- **Function**: `setNewParticipantServerAction(p: participantDataType)`
- **Location**: `app/actions/Summary.ts:201`
- **What it does**: Registers a new participant in the in-memory store
- **Called from**: MediaComponent when a participant joins
- **Data stored**: `{ id, name, offset, chunks: [], isFinished: false }`

### 3. Audio Chunk Recording
- **Function**: `setParticipantBlobChunk(id: string, blob: Blob, timestamp: number)`
- **Location**: `app/actions/Summary.ts:207`
- **What it does**: Stores audio chunks for each participant
- **Called from**: MediaComponent during recording (every 2.5 seconds)

### 4. Meeting End & Summary Generation
- **Function**: `stopMeeting(roomId: string)`
- **Location**: `app/actions/Summary.ts:344`
- **What it does**:
  1. Fetches organization member names from Clerk API
  2. Processes all participant audio chunks
  3. Transcribes audio using AssemblyAI
  4. Generates summary using HuggingFace
  5. Resolves participant names from organization members
  6. Calls `saveMeetingSummary()` to save to database
- **Called from**: MediaComponent when meeting ends (line 267)

### 5. Database Save
- **Function**: `saveMeetingSummary(summary: MeetingSummary, roomId: string)`
- **Location**: `app/actions/Summary.ts:483`
- **What it does**:
  1. Gets `orgId` from auth context or room table
  2. Prepares data for insertion
  3. Inserts into `meeting_summaries` table
  4. Returns saved data or null on error

## Database Schema

### Table: `meeting_summaries`

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key (auto-generated) |
| `room_id` | TEXT | Room ID where meeting took place |
| `org_id` | TEXT | Organization ID |
| `created_by` | TEXT | User ID who created the summary |
| `summary_text` | TEXT | AI-generated summary |
| `key_points` | JSONB | Array of key points |
| `participants` | TEXT[] | Array of participant user IDs |
| `participant_names` | JSONB | Object mapping IDs to names `{ "userId": "Name" }` |
| `duration_ms` | BIGINT | Meeting duration in milliseconds |
| `start_time` | TIMESTAMPTZ | Meeting start time (ISO string) |
| `end_time` | TIMESTAMPTZ | Meeting end time (ISO string) |
| `transcriptions` | JSONB | Array of transcription objects |
| `created_at` | TIMESTAMPTZ | Record creation timestamp (auto) |

### Transcription Object Structure
```json
{
  "id": "user_123",
  "name": "John Doe",
  "text": "Transcribed text here..."
}
```

## Verification Checklist

### ✅ Step 1: Create the Table
1. Go to Supabase Dashboard → SQL Editor
2. Run the SQL script: `database/create_meeting_summaries_table.sql`
3. Verify table exists: Check Table Editor → `meeting_summaries`

### ✅ Step 2: Check Environment Variables
Ensure these are set in `.env.local`:
```env
NEXT_PUBLIC_SUPABASE_URL=your_supabase_url
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
CLERK_SECRET_KEY=your_clerk_secret_key
ASSEMBLYAI_API_KEY=your_assemblyai_key
HUGGINGFACE_API_KEY=your_huggingface_key
```

### ✅ Step 3: Test the Workflow
1. Start a meeting in a room
2. Have participants join and speak
3. End the meeting
4. Check browser console for logs:
   - `💾 Attempting to save meeting summary to Supabase...`
   - `✅ Saved meeting summary to Supabase successfully!`
5. Check Supabase Table Editor for the new entry

### ✅ Step 4: Verify Data Format
Check that the saved entry has:
- ✅ `room_id` matches the room
- ✅ `org_id` is set (not null)
- ✅ `summary_text` contains the summary
- ✅ `key_points` is a JSON array
- ✅ `participants` is an array of user IDs
- ✅ `participant_names` is a JSON object with ID → Name mapping
- ✅ `transcriptions` is an array of objects with `id`, `name`, `text`

## Common Issues & Solutions

### Issue: No entries in database
**Possible causes:**
1. Table doesn't exist → Run the SQL script
2. Error during save → Check browser console for error logs
3. `orgId` is null → Check auth context and room table
4. Supabase permissions → Check RLS policies

**Debug steps:**
1. Check browser console for error messages
2. Look for `❌ Supabase insert error:` in logs
3. Verify `orgId` is being fetched correctly
4. Check Supabase logs in dashboard

### Issue: Names are user IDs instead of names
**Possible causes:**
1. `CLERK_SECRET_KEY` not set or invalid
2. Organization members not found
3. Participant IDs don't match Clerk user IDs

**Debug steps:**
1. Check console for: `📋 Resolved X member names from organization`
2. Verify `CLERK_SECRET_KEY` is correct
3. Check that participant IDs match Clerk user IDs

### Issue: Empty summary or transcriptions
**Possible causes:**
1. No audio recorded
2. AssemblyAI transcription failed
3. HuggingFace summarization failed

**Debug steps:**
1. Check console for transcription logs
2. Verify audio chunks were recorded
3. Check API keys are valid

## Data Flow Diagram

```
MediaComponent
    ↓
Init() → Initialize meeting
    ↓
setNewParticipantServerAction() → Register participants
    ↓
setParticipantBlobChunk() → Record audio (repeated)
    ↓
stopMeeting()
    ↓
getOrganizationMemberNames() → Fetch names from Clerk
    ↓
transcribeWithAssemblyAI() → Transcribe audio
    ↓
summarizeWithHuggingFace() → Generate summary
    ↓
saveMeetingSummary()
    ↓
Supabase INSERT → meeting_summaries table
```

## Testing Commands

### Check if table exists (Supabase SQL Editor):
```sql
SELECT * FROM meeting_summaries LIMIT 1;
```

### Check latest entries:
```sql
SELECT 
  id,
  room_id,
  org_id,
  summary_text,
  key_points,
  participants,
  participant_names,
  duration_ms,
  start_time,
  end_time,
  created_at
FROM meeting_summaries
ORDER BY created_at DESC
LIMIT 5;
```

### Check participant names format:
```sql
SELECT 
  id,
  participants,
  participant_names,
  jsonb_object_keys(participant_names) as participant_id,
  participant_names->jsonb_object_keys(participant_names) as participant_name
FROM meeting_summaries
WHERE participant_names != '{}'::jsonb
LIMIT 5;
```

