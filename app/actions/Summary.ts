'use server'

import fs from 'fs'
import os from 'os'
import path from 'path'
import { createClient } from '@supabase/supabase-js'
import { auth } from '@clerk/nextjs/server'

// ──────────────────────────────────────────────
// FIX: Allow duplex for fetch (Node.js limitation)
// ──────────────────────────────────────────────
declare global {
  interface RequestInit {
    duplex?: 'half'
  }
}

// ──────────────────────────────────────────────
// ENVIRONMENT VARIABLES
// ──────────────────────────────────────────────
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY!
const HUGGINGFACE_API_KEY = process.env.HUGGINGFACE_API_KEY!

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY)
  throw new Error('❌ Missing Supabase keys.')
if (!ASSEMBLYAI_API_KEY)
  throw new Error('❌ Missing AssemblyAI key.')
if (!HUGGINGFACE_API_KEY)
  throw new Error('❌ Missing Hugging Face key.')

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// ──────────────────────────────────────────────
// TYPES
// ──────────────────────────────────────────────
export type participantDataType = {
  id: string
  name?: string
  offset: number
  chunks: Blob[]
  isFinished: boolean
}

export type MeetingSummary = {
  summary: string
  keyPoints: string[]
  participants: string[]
  participantNames: Record<string, string>
  transcriptions: { id: string; name?: string; text: string }[]
  duration: number
  startTime: string
  endTime: string
}

// ──────────────────────────────────────────────
// IN-MEMORY STORAGE
// ──────────────────────────────────────────────
const participantData: Record<string, participantDataType> = {}
let meetingStartTime: number | null = null

// ──────────────────────────────────────────────
// HELPERS
// ──────────────────────────────────────────────
async function blobToTempFile(blob: Blob, prefix = 'audio'): Promise<string> {
  const arrayBuffer = await blob.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)
  const tmpPath = path.join(os.tmpdir(), `${prefix}-${Date.now()}.webm`)
  await fs.promises.writeFile(tmpPath, buffer)
  return tmpPath
}
async function removeFile(p: string) {
  try {
    await fs.promises.unlink(p)
  } catch {}
}

/**
 * Fetches organization members from Clerk and returns a mapping of userId -> name
 * Uses the same name resolution logic as PlayersPanel.tsx
 */
async function getOrganizationMemberNames(orgId: string | null): Promise<Record<string, string>> {
  if (!orgId) {
    console.warn('⚠️ No orgId provided for fetching member names')
    return {}
  }

  try {
    const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY
    if (!CLERK_SECRET_KEY) {
      console.warn('⚠️ CLERK_SECRET_KEY not found, cannot fetch organization members')
      return {}
    }

    // Fetch organization memberships from Clerk Backend API
    // The API returns paginated results, so we need to handle pagination
    let allMemberships: any[] = []
    let page = 1
    const limit = 500 // Clerk's max per page

    while (true) {
      const response = await fetch(
        `https://api.clerk.com/v1/organizations/${orgId}/memberships?limit=${limit}&offset=${(page - 1) * limit}`,
        {
          headers: {
            'Authorization': `Bearer ${CLERK_SECRET_KEY}`,
            'Content-Type': 'application/json',
          },
        }
      )

      if (!response.ok) {
        if (page === 1) {
          console.warn(`⚠️ Failed to fetch organization members: ${response.statusText}`)
        }
        break
      }

      const data = await response.json()
      const memberships = Array.isArray(data) ? data : (data?.data || [])

      if (memberships.length === 0) {
        break
      }

      allMemberships = allMemberships.concat(memberships)

      // If we got fewer results than the limit, we've reached the end
      if (memberships.length < limit) {
        break
      }

      page++
    }

    // Map memberships to userId -> name, using same logic as PlayersPanel.tsx
    const nameMap: Record<string, string> = {}
    
    for (const membership of allMemberships) {
      // Clerk API returns public_user_data with different structure
      const publicUserData = membership.public_user_data || membership.publicUserData
      const userId = publicUserData?.user_id || publicUserData?.userId
      
      if (!userId) continue

      const first = (publicUserData?.first_name || publicUserData?.firstName)?.trim()
      const last = (publicUserData?.last_name || publicUserData?.lastName)?.trim()
      const hasName = first || last
      const username = publicUserData?.username
      const identifier = publicUserData?.identifier as string | undefined
      const emailPrefix = identifier && identifier.includes('@')
        ? identifier.split('@')[0]
        : identifier

      const name = hasName
        ? [first, last].filter(Boolean).join(' ')
        : (username || emailPrefix || 'Member')

      nameMap[userId] = name
    }

    console.log(`✅ Fetched ${Object.keys(nameMap).length} organization member names`)
    return nameMap
  } catch (err) {
    console.error('❌ Error fetching organization members:', err)
    return {}
  }
}

// ──────────────────────────────────────────────
// 1️⃣ TRANSCRIBE WITH ASSEMBLYAI
// ──────────────────────────────────────────────
async function transcribeWithAssemblyAI(blob: Blob): Promise<string> {
  const tmpPath = await blobToTempFile(blob)
  try {
    console.log('🎙️ Uploading audio to AssemblyAI...')

    const uploadResp = await fetch('https://api.assemblyai.com/v2/upload', {
      method: 'POST',
      headers: { authorization: ASSEMBLYAI_API_KEY },
      body: fs.createReadStream(tmpPath) as any,
      duplex: 'half',
    })
    const { upload_url } = await uploadResp.json()

    console.log('🔗 Uploaded. Starting transcription job...')
    const transcriptReq = await fetch('https://api.assemblyai.com/v2/transcript', {
      method: 'POST',
      headers: {
        authorization: ASSEMBLYAI_API_KEY,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ audio_url: upload_url }),
      duplex: 'half',
    })
    const job = await transcriptReq.json()

    // Poll until finished
    let status = job.status
    let result: any = null
    while (status !== 'completed' && status !== 'error') {
      await new Promise((r) => setTimeout(r, 3000))
      const poll = await fetch(`https://api.assemblyai.com/v2/transcript/${job.id}`, {
        headers: { authorization: ASSEMBLYAI_API_KEY },
      })
      result = await poll.json()
      status = result.status
    }

    if (status === 'completed') {
      console.log('✅ Transcription complete. Length:', result.text?.length || 0)
      return result.text || ''
    }
    console.error('❌ AssemblyAI error:', result?.error)
    return ''
  } catch (err) {
    console.error('⚠️ AssemblyAI failed:', err)
    return ''
  } finally {
    await removeFile(tmpPath)
  }
}

// ──────────────────────────────────────────────
// 2️⃣ SUMMARIZE WITH HUGGINGFACE (UPDATED ENDPOINT)
// ──────────────────────────────────────────────
async function summarizeWithHuggingFace(transcript: string) {
  try {
    const model = 'facebook/bart-large-cnn'
    // Use router endpoint as api-inference is deprecated
    const apiUrl = `https://router.huggingface.co/hf-inference/models/${model}`

    console.log('🧾 Full transcript being summarized:', transcript.slice(0, 500))
    console.log('🔗 Using HuggingFace API URL:', apiUrl)

    const resp = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${HUGGINGFACE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ inputs: transcript.slice(0, 4000) }),
    })

    // Read response text once (can only be read once)
    const responseText = await resp.text()
    const contentType = resp.headers.get('content-type')

    // Check response status
    if (!resp.ok) {
      console.error('❌ HuggingFace API HTTP error:', resp.status, resp.statusText)
      console.error('❌ Error response:', responseText.substring(0, 500))
      
      // If model is loading, retry after delay
      if (resp.status === 503) {
        console.log('⚙️ Model loading... retrying in 15s')
        await new Promise((r) => setTimeout(r, 15000))
        return await summarizeWithHuggingFace(transcript)
      }
      
      return { 
        summary: `HuggingFace API error (${resp.status}): ${resp.statusText}`, 
        keyPoints: [] 
      }
    }

    // Check content type before parsing JSON
    if (!contentType || !contentType.includes('application/json')) {
      console.error('❌ HuggingFace API returned non-JSON response')
      console.error('❌ Content-Type:', contentType)
      console.error('❌ Response preview:', responseText.substring(0, 500))
      
      // If it's HTML, it's likely an error page
      if (responseText.trim().startsWith('<!DOCTYPE') || responseText.trim().startsWith('<!doctype')) {
        return { 
          summary: 'HuggingFace API returned an error page. Please check your API key and model availability.', 
          keyPoints: [] 
        }
      }
      
      return { 
        summary: 'HuggingFace API returned unexpected response format.', 
        keyPoints: [] 
      }
    }

    // Parse JSON response
    let data
    try {
      data = JSON.parse(responseText)
    } catch (parseError) {
      console.error('❌ Failed to parse HuggingFace response as JSON')
      console.error('❌ Parse error:', parseError)
      console.error('❌ Response text:', responseText.substring(0, 500))
      return { 
        summary: 'Failed to parse HuggingFace API response.', 
        keyPoints: [] 
      }
    }

    // Handle model loading response
    if (data?.error?.includes('loading') || data?.error?.includes('is currently loading')) {
      console.log('⚙️ Model loading... retrying in 15s')
      await new Promise((r) => setTimeout(r, 15000))
      return await summarizeWithHuggingFace(transcript)
    }

    if (data?.error) {
      console.error('❌ Hugging Face API error:', data.error)
      return { summary: `Hugging Face API error: ${data.error}`, keyPoints: [] }
    }

    // Extract summary text from response
    const text =
      Array.isArray(data) && data[0]?.summary_text
        ? data[0].summary_text
        : Array.isArray(data) && data[0]?.generated_text
        ? data[0].generated_text
        : typeof data === 'string'
        ? data
        : data?.summary_text || data?.generated_text || ''

    if (!text) {
      console.warn('⚠️ No summary returned from HuggingFace')
      console.warn('⚠️ Response data:', JSON.stringify(data).substring(0, 500))
      return { summary: 'No summary returned from HuggingFace API.', keyPoints: ['No summary available'] }
    }

    const keyPoints = text
      .split(/[.?!]/)
      .map((t: string) => t.trim())
      .filter((t: string) => t.length > 4)
      .slice(0, 5)

    console.log('🧠 Hugging Face summary generated successfully.')
    console.log('📝 Summary Preview:', text.slice(0, 200))
    return { summary: text, keyPoints }
  } catch (err) {
    console.error('❌ Hugging Face summarization failed:', err)
    if (err instanceof Error) {
      console.error('❌ Error message:', err.message)
      console.error('❌ Error stack:', err.stack)
    }
    return { summary: '', keyPoints: [] }
  }
}

// ──────────────────────────────────────────────
// 3️⃣ MEETING ACTIONS
// ──────────────────────────────────────────────
export async function Init(startTime: number) {
  meetingStartTime = startTime
  for (const k of Object.keys(participantData)) delete participantData[k]
  console.log('🟢 Meeting initialized at', new Date(startTime).toISOString())
  return true
}

export async function setNewParticipantServerAction(p: participantDataType) {
  participantData[p.id] = { ...p, chunks: [], isFinished: false }
  console.log(`👤 Added participant ${p.id} (${p.name ?? 'Unnamed'})`)
  return true
}

export async function setParticipantBlobChunk(id: string, blob: Blob, timestamp: number) {
  // Auto-initialize meeting if not already initialized
  if (!meetingStartTime) {
    console.warn(`⚠️ Meeting not initialized when chunk received. Auto-initializing...`)
    meetingStartTime = timestamp // Use actual first chunk timestamp as start time
    console.log('🟢 Meeting auto-initialized at', new Date(meetingStartTime).toISOString())
  }

  // Auto-register participant if not already registered
  if (!participantData[id]) {
    console.warn(`⚠️ Participant ${id} not registered. Auto-registering...`)
    participantData[id] = {
      id,
      name: undefined,
      offset: timestamp,
      chunks: [],
      isFinished: false
    }
    console.log(`👤 Auto-registered participant ${id}`)
  }

  const p = participantData[id]
  p.chunks.push(blob)
  p.offset = timestamp
  console.log(`📦 Received blob from ${p.name || id} (${blob.size} bytes)`)
  return true
}

export async function stopRecorder(id: string, stopTime: number) {
  const p = participantData[id];
  if (!p || p.chunks.length === 0) {
    console.warn(`⚠️ No data to stopRecorder for ID ${id}`);
    return null;
  }

  try {
    p.isFinished = true;
    const combined = new Blob(p.chunks, { type: 'audio/webm;codecs=opus' });
    const sizeKB = (combined.size / 1024).toFixed(2);
    console.log(`🎧 Stopping recorder for ${p.name || id}. Blob size: ${sizeKB} KB`);

    if (combined.size === 0) {
      console.warn(`⚠️ Blob is empty for ${id}. Skipping transcription.`);
      return { id, name: p.name ?? id, text: '' };
    }

    const text = await transcribeWithAssemblyAI(combined);
    if (!text || text.trim().length === 0) {
      console.warn(`⚠️ Empty transcription for ${p.name || id}`);
    } else {
      console.log(`📝 Transcript for ${p.name || id}: ${text.slice(0, 200)}...`);
    }

    return { id, name: p.name ?? id, text };
  } catch (err) {
    console.error(`❌ Error in stopRecorder for ${id}:`, err);
    return { id, name: p.name ?? id, text: '' };
  }
}


export async function stopMeeting(roomId: string): Promise<MeetingSummary | null> {
  console.log('🛑 stopMeeting() called with roomId:', roomId);
  console.log('🔍 Current meetingStartTime:', meetingStartTime);
  console.log('🔍 Current participants:', Object.keys(participantData));
  
  // If meeting wasn't initialized, calculate from participant data
  if (!meetingStartTime) {
    console.warn('⚠️ Meeting start time not set. Calculating from participant data...');
    const participants = Object.values(participantData);
    // Use the earliest participant offset as the start time
    if (participants.length > 0) {
      const earliestOffset = Math.min(...participants.map(p => p.offset));
      meetingStartTime = earliestOffset;
      console.log('🟢 Meeting start time calculated from earliest participant:', new Date(meetingStartTime).toISOString());
    } else {
      // Last resort: use current time (no extra time added)
      meetingStartTime = Date.now();
      console.log('🟢 Meeting initialized with current time (no participants found):', new Date(meetingStartTime).toISOString());
    }
  }

  const participants = Object.values(participantData);
  const endTime = Date.now();
  const duration = endTime - meetingStartTime;
  
  console.log('📊 Meeting stats:', {
    participantsCount: participants.length,
    duration: `${(duration / 60000).toFixed(2)} minutes`,
    startTime: new Date(meetingStartTime).toISOString(),
    endTime: new Date(endTime).toISOString(),
  });

  console.log('\n===============================');
  console.log('🛑 Meeting Ended');
  console.log(`🕒 Duration: ${(duration / 60000).toFixed(2)} minutes`);
  console.log(`👥 Participants: ${participants.length}`);
  console.log('===============================\n');

  // Get orgId from auth context or from room
  const { orgId } = await auth();
  let memberNames: Record<string, string> = {}
  
  if (orgId) {
    // Fetch organization member names to properly resolve participant names
    memberNames = await getOrganizationMemberNames(orgId)
    console.log(`📋 Resolved ${Object.keys(memberNames).length} member names from organization`)
  } else {
    // Try to get orgId from room
    try {
      const { data: roomData } = await supabase
        .from('rooms')
        .select('org_id')
        .eq('id', roomId)
        .single()
      
      if (roomData?.org_id) {
        memberNames = await getOrganizationMemberNames(roomData.org_id)
        console.log(`📋 Resolved ${Object.keys(memberNames).length} member names from room's organization`)
      }
    } catch (err) {
      console.warn('⚠️ Could not fetch orgId from room:', err)
    }
  }

  const transcriptions: { id: string; name?: string; text: string }[] = [];

  for (const p of participants) {
    // Resolve name from organization members, fallback to stored name, then to ID
    const resolvedName = memberNames[p.id] || p.name || p.id
    console.log(`🎤 [${resolvedName} (${p.id})] Processing ${p.chunks.length} chunks...`);

    if (p.chunks.length === 0) {
      console.warn(`⚠️ ${resolvedName} had no chunks recorded.`);
      transcriptions.push({ id: p.id, name: resolvedName, text: '' });
      continue;
    }

    try {
      const combined = new Blob(p.chunks, { type: 'audio/webm;codecs=opus' });
      const sizeKB = (combined.size / 1024).toFixed(2);
      console.log(`📀 [${resolvedName}] Combined blob size: ${sizeKB} KB`);

      if (combined.size === 0) {
        console.warn(`⚠️ Blob is empty for ${resolvedName}`);
        transcriptions.push({ id: p.id, name: resolvedName, text: '' });
        continue;
      }

      const text = await transcribeWithAssemblyAI(combined);
      if (!text || text.trim().length === 0) {
        console.warn(`⚠️ Empty or failed transcription for ${resolvedName}`);
      } else {
        console.log(`📝 [${resolvedName}] Transcript:\n${text.slice(0, 200)}${text.length > 200 ? '...' : ''}`);
      }

      transcriptions.push({ id: p.id, name: resolvedName, text });
    } catch (err) {
      console.error(`❌ Error transcribing for ${resolvedName}:`, err);
      transcriptions.push({ id: p.id, name: resolvedName, text: '' });
    }
  }

  // Build combined transcript text using resolved names
  const fullTranscript = transcriptions
    .map((t) => `${t.name ?? t.id}: ${t.text}`)
    .join('\n')
    .trim();

  // Create participant names mapping using resolved names
  const participantNames: Record<string, string> = {}
  for (const p of participants) {
    participantNames[p.id] = memberNames[p.id] || p.name || p.id
  }

  if (fullTranscript.length === 0) {
    console.warn('⚠️ No transcription data available. Generating placeholder summary.');
    const placeholderSummary = {
      summary: 'No speech detected during this meeting.',
      keyPoints: ['No audio captured', 'Meeting contained silence or technical issues'],
    };

    const result: MeetingSummary = {
      summary: placeholderSummary.summary,
      keyPoints: placeholderSummary.keyPoints,
      participants: participants.map((p) => p.id),
      participantNames,
      transcriptions,
      duration,
      startTime: new Date(meetingStartTime).toISOString(),
      endTime: new Date(endTime).toISOString(),
    };

    console.log('🧩 Saving placeholder summary to Supabase...');
    await saveMeetingSummary(result, roomId);
    return result;
  }

  // Generate AI summary
  console.log('🤖 Starting AI summarization...');
  let summary = '';
  let keyPoints: string[] = [];
  
  try {
    const summaryResult = await summarizeWithHuggingFace(fullTranscript);
    summary = summaryResult.summary || '';
    keyPoints = summaryResult.keyPoints || [];
    
    // Check if summary is an error message or empty
    const isError = summary.includes('error') || summary.includes('Error') || summary.includes('API error');
    
    if (summary && !isError && keyPoints.length > 0) {
      console.log('\n✅ Meeting summarized successfully!');
      console.log('📋 Summary:', summary.slice(0, 200) || '(empty)');
      console.log('📌 Key Points:', keyPoints);
    } else {
      console.warn('⚠️ Summarization failed or returned error, using fallback from transcript');
      // Create a simple summary from the transcript
      summary = `Meeting discussion: ${fullTranscript.substring(0, 500)}${fullTranscript.length > 500 ? '...' : ''}`;
      keyPoints = fullTranscript
        .split(/[.?!]/)
        .map((t: string) => t.trim())
        .filter((t: string) => t.length > 10)
        .slice(0, 5);
      console.log('📝 Using fallback summary from transcript');
    }
  } catch (err) {
    console.error('❌ Error during summarization:', err);
    // Create fallback summary from transcript
    summary = `Meeting discussion: ${fullTranscript.substring(0, 500)}${fullTranscript.length > 500 ? '...' : ''}`;
    keyPoints = fullTranscript
      .split(/[.?!]/)
      .map((t: string) => t.trim())
      .filter((t: string) => t.length > 10)
      .slice(0, 5);
    console.log('📝 Using fallback summary from transcript');
  }

  const result: MeetingSummary = {
    summary,
    keyPoints,
    participants: participants.map((p) => p.id),
    participantNames,
    transcriptions,
    duration,
    startTime: new Date(meetingStartTime).toISOString(),
    endTime: new Date(endTime).toISOString(),
  };

  console.log('👥 Participant Names:', participantNames);
  console.log('💾 Proceeding to save meeting summary...');

  // Always save, even if summarization failed
  try {
    const saveResult = await saveMeetingSummary(result, roomId);
    
    if (saveResult && saveResult.length > 0) {
      console.log('✅ Meeting summary saved successfully!');
      console.log('📋 Saved entry ID:', saveResult[0]?.id);
      console.log('📋 Saved entry created_at:', saveResult[0]?.created_at);
    } else {
      console.error('❌ Failed to save meeting summary to database - saveResult was null or empty');
      console.error('❌ Save result:', saveResult);
    }
  } catch (saveError) {
    console.error('❌ Exception while saving meeting summary:', saveError);
    if (saveError instanceof Error) {
      console.error('❌ Error message:', saveError.message);
      console.error('❌ Error stack:', saveError.stack);
    }
  }
  
  return result;
}


export async function saveMeetingSummary(summary: MeetingSummary, roomId: string) {
  console.log('💾 Attempting to save meeting summary to Supabase...')
  console.log('📋 Summary data:', {
    roomId,
    summaryLength: summary.summary?.length || 0,
    keyPointsCount: summary.keyPoints?.length || 0,
    participantsCount: summary.participants?.length || 0,
    participantNamesCount: Object.keys(summary.participantNames || {}).length,
    transcriptionsCount: summary.transcriptions?.length || 0,
    duration: summary.duration,
    startTime: summary.startTime,
    endTime: summary.endTime,
  })
  
  try {
    // Get orgId from auth context, or try to get it from room
    const { orgId: authOrgId, userId } = await auth()
    let orgId = authOrgId

    console.log('🔍 Auth context - orgId:', orgId, 'userId:', userId)

    // If no orgId from auth, try to get it from the room
    if (!orgId) {
      try {
        console.log('🔍 Fetching orgId from room:', roomId)
        const { data: roomData, error: roomError } = await supabase
          .from('rooms')
          .select('org_id')
          .eq('id', roomId)
          .single()
        
        if (roomError) {
          console.error('❌ Error fetching room data:', roomError)
        } else {
          console.log('📋 Room data:', roomData)
        }
        
        if (roomData?.org_id) {
          orgId = roomData.org_id
          console.log('✅ Got orgId from room:', orgId)
        }
      } catch (err) {
        console.error('❌ Exception fetching orgId from room:', err)
      }
    }

    // Fallback to env variable if still no orgId
    if (!orgId) {
      orgId = process.env.DEFAULT_ORG_ID ?? 'org_default'
      console.warn('⚠️ Using fallback orgId:', orgId)
    }

    const createdBy = userId ?? process.env.SYSTEM_USER_ID ?? 'system'
    console.log('👤 Created by:', createdBy)

    // Prepare insert data
    const insertData = {
      room_id: roomId,
      org_id: orgId,
      created_by: createdBy,
      summary_text: summary.summary || '',
      key_points: summary.keyPoints || [],
      participants: summary.participants || [],
      participant_names: summary.participantNames || {},
      duration_ms: summary.duration || 0,
      start_time: summary.startTime,
      end_time: summary.endTime,
      transcriptions: summary.transcriptions || [],
    }

    console.log('📤 Inserting data to meeting_summaries table:', {
      ...insertData,
      summary_text: insertData.summary_text.substring(0, 100) + '...',
      transcriptions: `[${insertData.transcriptions.length} items]`,
    })

    const { data, error } = await supabase
      .from('meeting_summaries')
      .insert(insertData)
      .select()

    if (error) {
      console.error('❌ Supabase insert error:', error)
      console.error('❌ Error details:', JSON.stringify(error, null, 2))
      console.error('❌ Error code:', error.code)
      console.error('❌ Error message:', error.message)
      console.error('❌ Error hint:', error.hint)
      console.error('❌ Error details:', error.details)
      throw error // Throw error so it can be caught by caller
    }

    if (!data || data.length === 0) {
      console.error('❌ Supabase insert returned no data')
      throw new Error('Insert returned no data')
    }

    console.log('✅ Saved meeting summary to Supabase successfully!')
    console.log('📋 Saved data:', JSON.stringify(data, null, 2))
    console.log('📋 Entry ID:', data[0]?.id)
    console.log('📋 Entry created_at:', data[0]?.created_at)
    
    // Verify the entry was actually saved by querying it back
    const { data: verifyData, error: verifyError } = await supabase
      .from('meeting_summaries')
      .select('id, created_at')
      .eq('id', data[0].id)
      .single()
    
    if (verifyError) {
      console.warn('⚠️ Could not verify saved entry:', verifyError)
    } else {
      console.log('✅ Verified entry exists in database:', verifyData)
    }
    
    return data
  } catch (err) {
    console.error('❌ Exception in saveMeetingSummary:', err)
    if (err instanceof Error) {
      console.error('❌ Error message:', err.message)
      console.error('❌ Error stack:', err.stack)
    }
    return null
  }
}

/**
 * Gets meeting summaries for a specific room
 */




// ✅ Create Supabase client once

export async function getMeetingSummaries(orgId: string): Promise<any[]> {
    const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  try {
    const { userId } = await auth();

    if (!userId) {
      console.warn('⚠️ No logged-in user found.');
      return [];
    }

    // Query by orgId instead of roomId to get all meeting summaries for the organization
    const { data, error } = await supabase
      .from('meeting_summaries')
      .select('*')
      .eq('org_id', orgId)
      .order('start_time', { ascending: false });

    if (error) {
      console.error('❌ Error fetching meeting summaries:', error);
      return [];
    }

    console.log(`✅ Fetched ${data?.length || 0} summaries for organization:`, orgId);
    return data || [];
  } catch (err) {
    console.error('⚠️ Error in getMeetingSummaries():', err);
    return [];
  }
}


