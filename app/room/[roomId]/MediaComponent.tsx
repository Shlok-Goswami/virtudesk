'use client'
import React, { useState,useEffect,useCallback,useRef, Ref, RefObject, CSSProperties } from "react";
import {MODE,ModeType,destroyRealtime,participantType,registerSetMode,setModeState,setStreamState,startSignaling,RTCEventEmitter,registerSetParticipants,
        broadcastModeChange,broadCastUserNames,setCurrentStateName,registerSetUserNames,broadcastMeetingState,registerSetIsMeeting,
        sendMeetingInvite,getMyId,registerSetShowInviteNotification,renegotiate,handleMute,getSelfId,sendJoinMeetingRequest,sendJoinMeetingResponse,
        registerSetShowJoinRequestNotification,getAllPlayers
    } from "../../../game/realtime/PlayerRealtime"
import { useUser, useAuth, useOrganization } from '@clerk/nextjs';
import LeaveRoomButton from './LeaveRoomButton';
import { error } from "console";
// Math from phaser conflicts with native Math, using native Math directly
import { Mic, MicOff, PenSquare, PhoneOff, Video } from "lucide-react";
import { Span } from "next/dist/trace";
import {
  Init,
  participantDataType,
  setNewParticipantServerAction,
  setParticipantBlobChunk,
  stopMeeting,
  stopRecorder,
  type MeetingSummary,
  saveMeetingSummary
} from "@/app/actions/Summary";



import { set } from "react-hook-form";
import { CollaborativeWhiteboardProps } from "@/components/CollaborativeWhiteboard";

const CSS:CSSProperties={
    position:"absolute",top:"50%",left:"50%",
    backgroundColor:"black",
    width:"90%",height:"80%",
    display:"flex",
    transform:"translate(-50%,-50%)"
}
type propType={
    handleOpenWhiteboard:()=>void,
    set:React.Dispatch<React.SetStateAction<boolean>>,
    children:React.ReactNode,
    isWhiteboardOpen:boolean,
    roomId:string
}

export default function  MediaComponent(props:propType){
    
    const { orgRole } = useAuth();
    const { user, isLoaded } = useUser();
    const { organization } = useOrganization();

    const getUserRole = (): string => {
        if (!orgRole) return 'member';
        return orgRole.replace('org:', '');
    };

    const audioRefs=useRef<{[id:string]:HTMLAudioElement | null}>({});
    const myVideoRef=useRef<HTMLVideoElement | null>(null);
    const videoRefs=useRef<{[id:string]:HTMLVideoElement | null}>({});
    const hasSentMessage = useRef(false);
    const recorder=useRef<MediaRecorder | null>(null);
    const currentParticipantIdRef=useRef<string | null>(null); // Store participant ID to prevent it from changing

    const [myStream,setMyStream]=useState<MediaStream | null>(null)
    const [mode,setMode]=useState<ModeType>(MODE.PROXIMITY) // proximity | meeting
    const [participants,setParticipants]=useState<participantType[]>([]);
    const [userRole,setUserRole]=useState<string>(getUserRole()) // admin | team_manager | member
    const [userNames,setUserNames]= useState<{[id:string]:string}>({})
    const [isMeeting,setIsMeeting]=useState<boolean>(false)
    const [showInviteNotification,setShowInviteNotification]=useState<boolean>(false)
    const [isMuted,setIsMuted]=useState<boolean>(false)
    const [members, setMembers] = useState<Array<{ id: string; name: string; role: string; }>>([])
    const [meetingHost, setMeetingHost] = useState<string | null>(null)
    const [joinRequestNotification, setJoinRequestNotification] = useState<{name:string,id:string} | null>(null)
    const [roomPlayers, setRoomPlayers] = useState<Array<{ id: string; name?: string; character?: string; avatar?: string }>>([])
    
    
    function updateMode(m:ModeType){
        setMode(m);
        setModeState(m)
    }
    function updateMyStream(s:MediaStream){
        setMyStream(s)
        setStreamState(s)
    }

    const getUserMediaInit = useCallback(()=>{
        // Check if we're in the browser and mediaDevices is available
        if (typeof window === 'undefined' || !navigator?.mediaDevices?.getUserMedia) {
            console.warn('getUserMedia is not available in this environment');
            return;
        }
        
        navigator.mediaDevices.getUserMedia({audio:true})
        .then((s)=>{
            updateMyStream(s)
            startSignaling()
        })
        .catch((e)=>{console.error("Failed in getUserMedia()\n\n"+e)})
    },[])

    async function getUserMedia(c:{video:boolean,audio:boolean}){
        // Check if we're in the browser and mediaDevices is available
        if (typeof window === 'undefined' || !navigator?.mediaDevices?.getUserMedia) {
            throw new Error('getUserMedia is not available in this environment');
        }
        
        try{
            const newStream=await navigator.mediaDevices.getUserMedia({audio:c.audio,video:c.video,})
            updateMyStream(newStream);
            return newStream;

        }catch(e){throw new Error(""+e)}
    } 
    const handleRecorder=useCallback(async (s:MediaStream)=>{
        // Filter to only audio tracks to reduce blob size
        const audioTracks = s.getAudioTracks();
        if(audioTracks.length === 0){
            console.error("No audio tracks in stream");
            return;
        }
        
        // Create new stream with only audio tracks
        const audioOnlyStream = new MediaStream(audioTracks);
        
        // Get and store participant ID at the start - capture it in closure
        const participantId = getSelfId();
        if(!participantId || participantId === "notSet"){
            console.error("Invalid participant ID:", participantId);
            return;
        }
        
        // Get participant name from members list or user data
        let participantName = '';
        if (members.length > 0 && user) {
            const currentUserMember = members.find(m => m.id === user.id);
            participantName = currentUserMember?.name || user.fullName || user.username || user.primaryEmailAddress?.emailAddress || '';
        } else if (user) {
            participantName = user.fullName || user.username || user.primaryEmailAddress?.emailAddress || '';
        }
        
        // Store in ref for debugging, but use the closure variable for actual operations
        currentParticipantIdRef.current = participantId;
        
        // Log the ID we're using
        const logName = participantName || participantId;
        console.log(`[${logName} (${participantId})] Starting recorder. getSelfId() returned:`, participantId);
        console.log(`[${logName} (${participantId})] This ID will be used for all chunks and stopRecorder`);
        
        const n:participantDataType={
            id: participantId, // Use the captured participantId
            name: participantName || undefined, // Include name if available
            offset:Date.now(),
            chunks:[],
            isFinished:false
        }
        
        console.log(`[${logName} (${participantId})] Participant data created with ID: ${n.id}`);
        
        // Set participant BEFORE creating recorder
        await setNewParticipantServerAction(n);
        
        // Log that participant was set
        console.log(`[${logName} (${participantId})] ✅ Participant set with ID: ${n.id}`);
        
        // Use audio-only stream for recording
        recorder.current = new MediaRecorder(audioOnlyStream, {
            mimeType: 'audio/webm;codecs=opus' // Use opus codec for better compression
        });
        
        recorder.current.start(2500); // 2.5 second chunks
        
        // IMPORTANT: Use the captured participantId from closure, not from ref or getSelfId()
        // This ensures the same ID is used throughout the recording lifecycle
        const recordingParticipantId = participantId;
        
        recorder.current.ondataavailable = async (e) => {
            if(e.data && e.data.size > 0){
                // ALWAYS use the captured participantId from closure
                const currentGetSelfId = getSelfId();
                const timestamp = Date.now(); // Get current timestamp when chunk is available
                console.log(`[${recordingParticipantId}] Data available: ${e.data.size} bytes at timestamp: ${timestamp}`);
                console.log(`[${recordingParticipantId}] Using ID: ${recordingParticipantId}, getSelfId() now: ${currentGetSelfId}`);
                
                if(recordingParticipantId !== currentGetSelfId){
                    console.warn(`[${recordingParticipantId}] ⚠️ ID mismatch! Using captured ID: ${recordingParticipantId}, getSelfId() returned: ${currentGetSelfId}`);
                }
                
                await setParticipantBlobChunk(recordingParticipantId, e.data, timestamp).catch((error) => {
                    console.error(`[${recordingParticipantId}] Error setting participant blob chunk:`, error);
                });
            }
        }
        
recorder.current.onstop = async () => {
  const currentGetSelfId = getSelfId();
  console.log(`[${recordingParticipantId}] Recorder stopped at ${new Date().toISOString()}`);
  console.log(`[${recordingParticipantId}] Using ID: ${recordingParticipantId}, getSelfId() now: ${currentGetSelfId}`);

  if (recordingParticipantId !== currentGetSelfId) {
    console.warn(`[${recordingParticipantId}] ⚠️ ID mismatch! Using captured ID: ${recordingParticipantId}, getSelfId() returned: ${currentGetSelfId}`);
  }

  try {
    const result = await stopRecorder(recordingParticipantId, Date.now());
    if (!result) {
      console.error(`[${recordingParticipantId}] ❌ stopRecorder returned null — likely no chunks were processed.`);
    } else if (!result.text || result.text.trim().length === 0) {
      console.warn(`[${recordingParticipantId}] ⚠️ Transcription was empty or failed.`);
    } else {
      console.log(`🎤 [${result.name || recordingParticipantId}] Transcript:\n${result.text.slice(0, 200)}${result.text.length > 200 ? "..." : ""}`);
    }
  } catch (err) {
    console.error(`[${recordingParticipantId}] 🚨 Error in stopRecorder:`, err);
  } finally {
    currentParticipantIdRef.current = null;
  }
};


    },[recorder, members, user])
    const handleStartMeeting=useCallback(async ()=>{
        await Init(Date.now());
        const newStream:MediaStream=await getUserMedia({audio:true,video:true});
       await handleRecorder(newStream);

        updateMode(MODE.MEETING)
        broadcastModeChange(MODE.MEETING)
        const hostId = user?.id || getSelfId() || undefined
        broadcastMeetingState(true, hostId)
        props.set(true)
        setIsMeeting(true)
        // Set current user as meeting host
        if (hostId) {
            setMeetingHost(hostId)
        }
        renegotiate(newStream,MODE.MEETING);
        
    },[user])
    const handleJoinMeeting=useCallback(async ()=>{
        const newStream:MediaStream=await getUserMedia({audio:true,video:true});
        await handleRecorder(newStream)
        updateMode(MODE.MEETING)
        broadcastModeChange(MODE.MEETING)
        props.set(true)
        setIsMeeting(true)
        renegotiate(newStream,MODE.MEETING);
    },[])
    const handleLeaveMeeting=useCallback(async ()=>{
        recorder.current?.stop();
       
        const newStream : MediaStream= await getUserMedia({audio:true,video:false})
        updateMode(MODE.PROXIMITY)
        broadcastModeChange(MODE.PROXIMITY)
        
        // Check if there are other participants still in meeting (excluding self)
        const selfId = getSelfId();
        const otherParticipantsInMeeting = participants.filter((p) => 
            p.mode === MODE.MEETING && p.id !== selfId && p.id !== user?.id
        );
        
        // If no other participants are in meeting, end the meeting
        if(otherParticipantsInMeeting.length === 0){
            broadcastMeetingState(false);
            setMeetingHost(null); // Clear meeting host when meeting ends
            setIsMeeting(false); // Explicitly set isMeeting to false
           
            stopMeeting(props.roomId)
  .then((summary: MeetingSummary | null) => {
    if (!summary) {
      console.error("❌ No summary returned from stopMeeting()");
      return;
    }

    console.groupCollapsed("📝 Meeting Summary Result");
    console.log("📄 Summary Text:", summary.summary || "No summary text returned");
    console.log("📌 Key Points:", summary.keyPoints?.length ? summary.keyPoints : ["(none)"]);
    console.log(
      "👥 Participants:",
      summary.participants.map((id:string) => {
        const name = summary.participantNames?.[id] || id;
        return `${name} (${id})`;
      })
    );
    console.log("⏱️ Duration:", (summary.duration / 60000).toFixed(1), "minutes");
    console.groupEnd();

    saveMeetingSummary(summary, props.roomId)
      .then(() => {
        console.log("✅ Meeting summary saved to Supabase successfully!");
        alert("✅ Meeting summary saved! Check your Supabase table.");
      })
      .catch((error) => {
        console.error("❌ Error saving summary to Supabase:", error);
      });
  })
  .catch((error) => {
    console.error("❌ Error generating meeting summary:", error);
  });

        }
        // If others are still in meeting, just leave (they will see Join Meeting button)
        
        props.set(false)
        renegotiate(newStream,MODE.PROXIMITY);

    },[participants, props.roomId, user])

    const handleInvite=useCallback((participantId: string)=>{
        sendMeetingInvite(participantId);
    }, [])
    
    const handleAcceptInvite=useCallback(async ()=>{
        setShowInviteNotification(false);
        await handleJoinMeeting();
    },[])
    
    const handleRejectInvite=useCallback(()=>{
        setShowInviteNotification(false);
    },[])

    const handleRequestJoinMeeting=useCallback(()=>{
        if (!meetingHost || !user) return;
        // Get requester name from members or user data
        const requesterMember = members.find(m => m.id === user.id);
        const requesterName = requesterMember?.name || user.fullName || user.username || user.primaryEmailAddress?.emailAddress || 'Someone';
        sendJoinMeetingRequest(meetingHost, requesterName);
    },[meetingHost, user, members])

    const handleAcceptJoinRequest=useCallback(()=>{
        if (!joinRequestNotification) return;
        sendJoinMeetingResponse(joinRequestNotification.id, true);
        setJoinRequestNotification(null);
    },[joinRequestNotification])

    const handleRejectJoinRequest=useCallback(()=>{
        if (!joinRequestNotification) return;
        sendJoinMeetingResponse(joinRequestNotification.id, false);
        setJoinRequestNotification(null);
    },[joinRequestNotification])

    const registerEvents = useCallback(()=>{
        RTCEventEmitter.removeAllListeners("onTrack")
        RTCEventEmitter.on("onTrack",(from:string,track:MediaStreamTrack,mode:ModeType)=>{
                setParticipants((prev)=>{
                    let isPresent=false;
                    const updated = prev.map((p)=>{
                        if(p.id===from){
                            isPresent=true;
                            // Update stream with new track
                            const newStream = new MediaStream([track]);
                            return {...p, stream: newStream, mode: mode};
                        }
                        return p;
                    })
                    if(isPresent){
                        return updated;
                    }
                    else{
                        // Participant not in list, add them
                        let newParticipant:participantType={id:from,mode:mode,stream:new MediaStream([track])}
                        return [...updated,newParticipant]
                    }
                })
        })
        RTCEventEmitter.removeAllListeners("onMeetingTrack")
        RTCEventEmitter.on("onMeetingTrack",(from:string,track:MediaStreamTrack,mode:ModeType,flag:boolean)=>{
                setParticipants((prev)=>{
                    let isPresent=false;
                    prev.forEach((p)=>{
                        if(p.id===from){
                            isPresent=true;
                            if(!flag){
                                p.stream=new MediaStream([track])
                            }
                            else{
                                if(p.stream && p.stream.getTracks().length===1){
                                    p.stream.addTrack(track)
                                }
                            }
                        }
                    })
                    return [...prev]
                })
        })
        RTCEventEmitter.removeAllListeners("onParticipant");
        RTCEventEmitter.on("onParticipant",(participant:participantType)=>{
            setParticipants((prev)=>{

                let isPresent=false;  
                prev.forEach((p)=>{
                    if(p.id===participant.id){
                        isPresent=true;
                    }
                })
                if(isPresent){
                    return prev
                }
                else{
                    return [...prev,participant]
                }
            })      
        })
        RTCEventEmitter.removeAllListeners("onParticipantDisconnect");
        RTCEventEmitter.on("onParticipantDisconnect",(participantId:string)=>{
            setParticipants((prev)=>{
                // Remove the participant who disconnected
                const filtered = prev.filter(p => p.id !== participantId);
                // Clean up video ref for disconnected participant
                const element = videoRefs.current[participantId];
                if(element){
                    element.srcObject = null;
                }
                delete videoRefs.current[participantId];
                return filtered;
            })
        })
    },[])

    


    useEffect(()=>{
        registerSetMode(setMode)
        registerSetParticipants(setParticipants)
        registerSetUserNames(setUserNames)
        registerSetIsMeeting(setIsMeeting)
        registerSetShowInviteNotification(setShowInviteNotification)
        registerSetShowJoinRequestNotification(setJoinRequestNotification)

        getUserMediaInit();
        registerEvents()

        // Listen for join meeting accepted/rejected events
        RTCEventEmitter.on("join-meeting-accepted", async () => {
            await handleJoinMeeting();
        });
        RTCEventEmitter.on("join-meeting-rejected", () => {
            // Could show a notification that request was rejected
            console.log("Join meeting request was rejected");
        });

        return ()=>{
            registerSetMode(null);
            registerSetParticipants(null)
            registerSetUserNames(null)
            registerSetIsMeeting(null)
            registerSetShowInviteNotification(null)
            registerSetShowJoinRequestNotification(null)
            RTCEventEmitter.removeAllListeners("join-meeting-accepted")
            RTCEventEmitter.removeAllListeners("join-meeting-rejected")
            RTCEventEmitter.removeAllListeners("onParticipantDisconnect")
            RTCEventEmitter.removeAllListeners()
            recorder.current=null
        }
   },[])

    useEffect(() => {
        const role = getUserRole();
        setUserRole(role);
        console.log("orgRole:", orgRole, "userRole:", role);
    }, [orgRole]);

    // Load organization members for proper name display
    useEffect(() => {
        const load = async () => {
            if (!organization || !organization.getMemberships) return;
            try {
                const list = await organization.getMemberships();
                const arr = (list?.data || [])
                    .filter((m: any) => m.publicUserData?.userId)
                    .map((m: any) => {
                        const first = m.publicUserData?.firstName?.trim();
                        const last = m.publicUserData?.lastName?.trim();
                        const hasName = first || last;
                        const username = m.publicUserData?.username;
                        const identifier = m.publicUserData?.identifier as string | undefined;
                        const emailPrefix = identifier && identifier.includes("@")
                            ? identifier.split("@")[0]
                            : identifier;
                    
                        return {
                            id: m.publicUserData.userId as string,
                            name: hasName
                                ? [first, last].filter(Boolean).join(" ")
                                : (username || emailPrefix || "Member"),
                            role: m.role,
                        };
                    })
                setMembers(arr);
            } catch {}
        };
        void load();
    }, [organization]);

    // Call functions after we have the names from organization members
    // Wait for members to load, but also handle case where organization might not be available
    useEffect(() => {
        if (isLoaded && user && !hasSentMessage.current) {
            // If we have members loaded, prefer the name from members list
            // Otherwise, use user data as fallback
            let name = '';
            if (members.length > 0) {
                const currentUserMember = members.find(m => m.id === user.id);
                name = currentUserMember?.name || user.fullName || user.username || user.primaryEmailAddress?.emailAddress || '';
            } else {
                // Fallback: use user data directly if members haven't loaded yet
                // This ensures functions are called even if organization is not available
                name = user.fullName || user.username || user.primaryEmailAddress?.emailAddress || '';
            }
            
            // Call functions after we have the name
            registerSetUserNames(setUserNames)
            setCurrentStateName(name)
            broadCastUserNames(name)
            hasSentMessage.current = true;
        }
    }, [isLoaded, user, members]);

    // Track meeting host when meeting state changes
    useEffect(() => {
        // Listen for meeting started/ended events
        RTCEventEmitter.on("meeting-started", (hostId: string) => {
            setMeetingHost(hostId);
        });
        RTCEventEmitter.on("meeting-ended", () => {
            setMeetingHost(null);
        });

        return () => {
            RTCEventEmitter.removeAllListeners("meeting-started");
            RTCEventEmitter.removeAllListeners("meeting-ended");
        };
    }, [])

    // Get all players in the room
    useEffect(() => {
        const refreshPlayers = () => {
            const all = getAllPlayers();
            const filtered = all.filter((p) => p.id);
            setRoomPlayers(filtered);
        };
        
        refreshPlayers();
        const interval = setInterval(refreshPlayers, 1000);
        return () => clearInterval(interval);
    }, [])

    // Update meeting state based on participants
    useEffect(() => {
        const participantsInMeeting = participants.filter(p => p.mode === MODE.MEETING);
        const hasParticipantsInMeeting = participantsInMeeting.length > 0;
        
        // Update isMeeting state based on whether there are participants in meeting
        if(hasParticipantsInMeeting && !isMeeting){
            setIsMeeting(true);
        } else if(!hasParticipantsInMeeting && isMeeting){
            setIsMeeting(false);
            setMeetingHost(null);
        }
    }, [participants, isMeeting])

    useEffect(()=>{
        if(mode===MODE.PROXIMITY){
        participants.forEach((p)=>{
            if(p.mode!==MODE.PROXIMITY){
                return
            }
            const element=audioRefs.current[p.id];
            if(!element){throw new Error("AUDIO ELEMENT is null in mediacompionent.tsx ")}
            else{

                element.srcObject=p.stream
            }
           
        })
        }
        else if(mode===MODE.MEETING){
            participants.forEach((p)=>{
                if(p.mode!==MODE.MEETING){return;}
                const element=videoRefs.current[p.id];
                if(!element){throw new Error("VIDEO ELEMENT is null in mediacompionent.tsx ")}
                else{
                    element.srcObject=p.stream
                }
            })
            const element=myVideoRef.current
                if(!element){throw new Error("AUDIO ELEMENT is null in mediacompionent.tsx ")}
                else{
                    element.srcObject=myStream
                }
        }
        console.log("\n\n\n\n\\n\n\n\n\\n\n\n\n\n\n\n\n\n"+participants.length+"\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n")
    },[participants,mode])

  
    


 
    
    return<>
    {props.isWhiteboardOpen && (
        <div style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', zIndex: 120050 }}>
            {props.children}
        </div>
    )}
    
    {/* Meeting Invite Notification */}
    {showInviteNotification && mode!==MODE.MEETING && (
        <div style={{
            position:"fixed",
            top:"2rem",
            right:"2rem",
            zIndex:2000,
            padding:"1.25rem",
            backgroundColor:"rgba(15, 23, 42, 0.95)",
            backdropFilter:"blur(8px)",
            borderRadius:"0.75rem",
            border:"1px solid rgba(148, 163, 184, 0.15)",
            boxShadow:"0 10px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.5)",
            minWidth:"320px",
            maxWidth:"400px"
        }}>
            <div style={{
                display:"flex",
                flexDirection:"column",
                gap:"1rem"
            }}>
                <p style={{
                    color:"rgba(241, 245, 249, 0.95)",
                    fontSize:"0.875rem",
                    margin:0
                }}>
                    You have been invited to a meeting
                </p>
                <div style={{
                    display:"flex",
                    gap:"0.75rem",
                    justifyContent:"flex-end"
                }}>
                    <button
                        onClick={handleRejectInvite}
                        style={{
                            padding:"0.5rem 1rem",
                            backgroundColor:"rgba(71, 85, 105, 0.6)",
                            color:"rgba(241, 245, 249, 0.9)",
                            border:"1px solid rgba(148, 163, 184, 0.2)",
                            borderRadius:"0.5rem",
                            fontSize:"0.875rem",
                            fontWeight:"500",
                            cursor:"pointer",
                            transition:"all 0.2s ease-in-out"
                        }}
                        onMouseEnter={(e) => {
                            e.currentTarget.style.backgroundColor = "rgba(71, 85, 105, 0.8)";
                        }}
                        onMouseLeave={(e) => {
                            e.currentTarget.style.backgroundColor = "rgba(71, 85, 105, 0.6)";
                        }}
                    >Reject</button>
                    <button
                        onClick={handleAcceptInvite}
                        style={{
                            padding:"0.5rem 1rem",
                            backgroundColor:"rgba(99, 102, 241, 0.8)",
                            color:"white",
                            border:"none",
                            borderRadius:"0.5rem",
                            fontSize:"0.875rem",
                            fontWeight:"500",
                            cursor:"pointer",
                            transition:"all 0.2s ease-in-out"
                        }}
                        onMouseEnter={(e) => {
                            e.currentTarget.style.backgroundColor = "rgba(99, 102, 241, 1)";
                            e.currentTarget.style.transform = "scale(1.05)";
                        }}
                        onMouseLeave={(e) => {
                            e.currentTarget.style.backgroundColor = "rgba(99, 102, 241, 0.8)";
                            e.currentTarget.style.transform = "scale(1)";
                        }}
                    >Accept</button>
                </div>
            </div>
        </div>
    )}

    {/* Join Meeting Request Notification */}
    {joinRequestNotification && mode === MODE.MEETING && (
        <div style={{
            position:"fixed",
            top:"2rem",
            right:"2rem",
            zIndex:2000,
            padding:"1.25rem",
            backgroundColor:"rgba(15, 23, 42, 0.95)",
            backdropFilter:"blur(8px)",
            borderRadius:"0.75rem",
            border:"1px solid rgba(148, 163, 184, 0.15)",
            boxShadow:"0 10px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.5)",
            minWidth:"320px",
            maxWidth:"400px"
        }}>
            <div style={{
                display:"flex",
                flexDirection:"column",
                gap:"1rem"
            }}>
                <p style={{
                    color:"rgba(241, 245, 249, 0.95)",
                    fontSize:"0.875rem",
                    margin:0
                }}>
                    {joinRequestNotification.name} wants to join the meeting
                </p>
                <div style={{
                    display:"flex",
                    gap:"0.75rem",
                    justifyContent:"flex-end"
                }}>
                    <button
                        onClick={handleRejectJoinRequest}
                        style={{
                            padding:"0.5rem 1rem",
                            backgroundColor:"rgba(71, 85, 105, 0.6)",
                            color:"rgba(241, 245, 249, 0.9)",
                            border:"1px solid rgba(148, 163, 184, 0.2)",
                            borderRadius:"0.5rem",
                            fontSize:"0.875rem",
                            fontWeight:"500",
                            cursor:"pointer",
                            transition:"all 0.2s ease-in-out"
                        }}
                        onMouseEnter={(e) => {
                            e.currentTarget.style.backgroundColor = "rgba(71, 85, 105, 0.8)";
                        }}
                        onMouseLeave={(e) => {
                            e.currentTarget.style.backgroundColor = "rgba(71, 85, 105, 0.6)";
                        }}
                    >Reject</button>
                    <button
                        onClick={handleAcceptJoinRequest}
                        style={{
                            padding:"0.5rem 1rem",
                            backgroundColor:"rgba(34, 197, 94, 0.8)",
                            color:"white",
                            border:"none",
                            borderRadius:"0.5rem",
                            fontSize:"0.875rem",
                            fontWeight:"500",
                            cursor:"pointer",
                            transition:"all 0.2s ease-in-out"
                        }}
                        onMouseEnter={(e) => {
                            e.currentTarget.style.backgroundColor = "rgba(34, 197, 94, 1)";
                            e.currentTarget.style.transform = "scale(1.05)";
                        }}
                        onMouseLeave={(e) => {
                            e.currentTarget.style.backgroundColor = "rgba(34, 197, 94, 0.8)";
                            e.currentTarget.style.transform = "scale(1)";
                        }}
                    >Accept</button>
                </div>
            </div>
        </div>
    )}
        



{/*#############################################################################################################################################################################################################

-----------------------------------------------------------------------------PROXIMITY--------------------------------------------------------------------------------------------------------------------------

################################################################################################################################################################################################################
*/}

    {mode===MODE.PROXIMITY && 
        <>
            {participants.map((participant)=>{
                if(participant.mode!==MODE.PROXIMITY){return}
                return <audio 
                    playsInline
                    autoPlay
                    key={participant.id}
                    ref={(element)=>{audioRefs.current[participant.id]=element}}
                    className={"AudioElement"+participant.id}
                ></audio>
            })}
            {/* Show Start Meeting button when no one is in meeting and user is not a member */}
            {userRole!=="member" && mode !== MODE.MEETING && !participants.some(p => p.mode === MODE.MEETING) && 
             <button
             onClick={async (e) => { await handleStartMeeting() }}
             className={`fixed bottom-24 right-4 z-[1100] flex items-center justify-center gap-1.5 px-10.5 py-2.5 rounded-md border text-xs font-medium transition 
                 bg-blue-500 border-slate-200 text-white hover:bg-blue-600
                 disabled:opacity-50 disabled:cursor-not-allowed md:bottom-4 md:right-4 shadow-md`}
         >
             <Video className="w-4 h-4" />
             <span className="text-sm font-medium">Start Meeting</span>
         </button>
            }
            {/* Show Join Meeting button when at least one participant is in meeting and current user is not in meeting */}
            {mode !== MODE.MEETING && participants.some(p => p.mode === MODE.MEETING) && meetingHost && 
             <button
             onClick={handleRequestJoinMeeting}
             className={`fixed bottom-24 right-4 z-[1100] flex items-center justify-center gap-1.5 px-10.5 py-2.5 rounded-md border text-xs font-medium transition 
                 bg-green-500 border-slate-200 text-white hover:bg-green-600
                 disabled:opacity-50 disabled:cursor-not-allowed md:bottom-4 md:right-4 shadow-md`}
         >
             <Video className="w-4 h-4" />
             <span className="text-sm font-medium">Join Meeting</span>
         </button>
            }
        </>
    }
   



{/*#############################################################################           MEETING             ################################################################################################*/}


        {mode===MODE.MEETING && 
            <>
                <div className="fixed inset-0 z-[1001] flex flex-col gap-6 bg-slate-950/90 pl-6 pr-0 py-6 backdrop-blur-2xl md:pl-10 md:pr-0 md:py-10">
                    <div className="container grid w-full flex-1 grid-cols-[repeat(auto-fit,minmax(30rem,30rem))] justify-start gap-4 overflow-y-auto pr-2">
                        <div className="video_wrapper relative h-[360px] w-[480px] overflow-hidden rounded-xl bg-slate-900/80 shadow-lg shadow-black/40">
                            <video 
                                playsInline
                                autoPlay
                                className="MyVideo absolute inset-0 h-full w-full bg-slate-900 object-cover scale-x-[-1]"
                                ref={myVideoRef}
                                muted
                            ></video>
                        </div>
                       
                        {participants.map((participant,i)=>{
                            if(participant.mode!==MODE.MEETING){return;}
                            return <React.Fragment key={participant.id}>
                                <div className="video_wrapper relative h-[360px] w-[480px] overflow-hidden rounded-xl bg-slate-900/80 shadow-lg shadow-black/40">
                                    <video 
                                        playsInline
                                        autoPlay
                                        className={"absolute inset-0 h-full w-full bg-slate-900 object-cover scale-x-[-1] Vide aoElement"+participant.id}
                                        ref={(element)=>{videoRefs.current[participant.id]=element}}
                                    ></video>
                                </div>
                            </React.Fragment>
                        })}
                    </div>
                    <div className="Panel" 
                    style={{
                        position:"absolute",
                        right:"0.2%",
                        top:"1.5rem",
                        padding:"1rem",
                        backgroundColor:"rgba(15, 23, 42, 0.95)",
                        backdropFilter:"blur(8px)",
                        display:"flex",
                        flexDirection:"column",
                        width:"15%",
                        minWidth:"200px",
                        gap:"0.75rem",
                        borderRadius:"0.75rem",
                        border:"1px solid rgba(148, 163, 184, 0.1)",
                        boxShadow:"0 10px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.5)",
                        height:"fit-content",
                        maxHeight:"calc(100% - 3rem)",
                        overflowY:"auto",
                        overflowX:"hidden"
                    }}>
                        <div style={{
                            display:"flex",
                            flexDirection:"column",
                            gap:"0.5rem",
                            marginBottom:"0.5rem"
                        }}>
                            <h3 style={{
                                color:"rgba(241, 245, 249, 0.95)",
                                fontSize:"0.875rem",
                                fontWeight:"600",
                                marginBottom:"0.25rem",
                                padding:"0 0.25rem"
                            }}>Participants ({roomPlayers.length})</h3>
                        </div>
                        {roomPlayers.length === 0 && (
                            <div style={{
                                display:"flex",
                                alignItems:"center",
                                justifyContent:"center",
                                padding:"2rem 1rem",
                                color:"rgba(148, 163, 184, 0.7)",
                                fontSize:"0.875rem",
                                fontWeight:"400",
                                textAlign:"center",
                                width:"100%"
                            }}>
                                No Participants in Room
                            </div>
                        )}
                        {roomPlayers.map((player)=>{
                            // Get member info to check role
                            const member = members.find(m => m.id === player.id);
                            const playerRole = member?.role || "member";
                            const playerName = userNames[player.id] || member?.name || player.name || "Unknown User";
                            const isInMeeting = participants.some(p => p.id === player.id && p.mode === MODE.MEETING);
                            const isCurrentUser = player.id === user?.id || player.id === getSelfId();
                            // Admins and team_managers can invite anyone (including same roles), except themselves and those already in meeting
                            const canInvite = userRole !== "member" && !isCurrentUser && !isInMeeting;

                            return <React.Fragment key={player.id+"Participant"}>
                                <div  className="participantHolder" style={{
                                    display:"flex",
                                    alignItems:"center",
                                    justifyContent:"space-between",
                                    padding:"0.75rem 1rem",
                                    backgroundColor:isInMeeting ? "rgba(34, 197, 94, 0.1)" : "rgba(30, 41, 59, 0.6)",
                                    borderRadius:"0.5rem",
                                    border:isInMeeting ? "1px solid rgba(34, 197, 94, 0.3)" : "1px solid rgba(148, 163, 184, 0.15)",
                                    transition:"all 0.2s ease-in-out",
                                    gap:"0.75rem",
                                    minHeight:"3rem"
                                }}>
                                    <div style={{
                                        display:"flex",
                                        flexDirection:"column",
                                        flex:"1",
                                        minWidth:0
                                    }}>
                                        <span style={{
                                            color:"rgba(241, 245, 249, 0.95)",
                                            fontSize:"0.875rem",
                                            fontWeight:"500",
                                            letterSpacing:"0.025em",
                                            overflow:"hidden",
                                            textOverflow:"ellipsis",
                                            whiteSpace:"nowrap"
                                        }}>{playerName}</span>
                                        <span style={{
                                            color:isInMeeting ? "rgba(34, 197, 94, 0.8)" : "rgba(148, 163, 184, 0.6)",
                                            fontSize:"0.75rem",
                                            fontWeight:"400",
                                            marginTop:"0.125rem"
                                        }}>
                                            {isInMeeting ? "In Meeting" : "Available"}
                                        </span>
                                    </div>
                                    {canInvite && (
                                        <button
                                            onClick={() => handleInvite(player.id)}
                                            style={{
                                                padding:"0.375rem 0.75rem",
                                                backgroundColor:"rgba(59, 130, 246, 0.1)",
                                                border:"1px solid rgba(59, 130, 246, 0.3)",
                                                borderRadius:"0.375rem",
                                                color:"rgba(147, 197, 253, 0.9)",
                                                fontSize:"0.75rem",
                                                fontWeight:"500",
                                                cursor:"pointer",
                                                transition:"all 0.2s ease-in-out"
                                            }}
                                            onMouseEnter={(e) => {
                                                e.currentTarget.style.backgroundColor = "rgba(59, 130, 246, 0.2)";
                                            }}
                                            onMouseLeave={(e) => {
                                                e.currentTarget.style.backgroundColor = "rgba(59, 130, 246, 0.1)";
                                            }}
                                        >
                                            Invite
                                        </button>
                                    )}
                                </div>
                            </React.Fragment>
                        })}
                    </div>
                    
                    <div className="mt-auto flex flex-row items-center justify-center gap-3 pb-2">
                        <button 
                            style={{
                                width:"3rem",
                                height:"3rem",
                                borderRadius:"50%",
                                backgroundColor:isMuted ? "rgba(239, 68, 68, 0.8)" : "rgba(71, 85, 105, 0.8)",
                                border:"1px solid",
                                borderColor:isMuted ? "rgba(220, 38, 38, 0.3)" : "rgba(148, 163, 184, 0.2)",
                                display:"flex",
                                alignItems:"center",
                                justifyContent:"center",
                                cursor:"pointer",
                                transition:"all 0.2s ease-in-out",
                                color:"rgba(241, 245, 249, 0.9)",
                                boxShadow:"0 4px 6px -1px rgba(0, 0, 0, 0.3), 0 2px 4px -1px rgba(0, 0, 0, 0.2)"
                            }}
                            onClick={() => {
                                setIsMuted(!isMuted);
                                handleMute(!isMuted);
                            }}
                            onMouseEnter={(e) => {
                                e.currentTarget.style.backgroundColor = isMuted ? "rgba(220, 38, 38, 1)" : "rgba(71, 85, 105, 1)";
                                e.currentTarget.style.transform = "scale(1.05)";
                            }}
                            onMouseLeave={(e) => {
                                e.currentTarget.style.backgroundColor = isMuted ? "rgba(239, 68, 68, 0.8)" : "rgba(71, 85, 105, 0.8)";
                                e.currentTarget.style.transform = "scale(1)";
                            }}
                        >
                            {isMuted ? <MicOff size={20} /> : <Mic size={20} />}
                        </button>
                        {!props.isWhiteboardOpen && (
                            <button
                                style={{
                                    width: "3rem",
                                    height: "3rem",
                                    borderRadius: "50%",
                                    backgroundColor: "rgba(59, 130, 246, 0.85)",
                                    border: "1px solid rgba(37, 99, 235, 0.35)",
                                    color: "white",
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    cursor: "pointer",
                                    transition: "all 0.2s ease-in-out",
                                    boxShadow: "0 4px 6px -1px rgba(0, 0, 0, 0.3), 0 2px 4px -1px rgba(0, 0, 0, 0.2)"
                                }}
                                onClick={props.handleOpenWhiteboard}
                                onMouseEnter={(e) => {
                                    e.currentTarget.style.backgroundColor = "rgba(37, 99, 235, 1)";
                                    e.currentTarget.style.transform = "scale(1.05)";
                                    e.currentTarget.style.boxShadow = "0 6px 8px -1px rgba(0, 0, 0, 0.35), 0 4px 6px -1px rgba(0, 0, 0, 0.25)";
                                }}
                                onMouseLeave={(e) => {
                                    e.currentTarget.style.backgroundColor = "rgba(59, 130, 246, 0.85)";
                                    e.currentTarget.style.transform = "scale(1)";
                                    e.currentTarget.style.boxShadow = "0 4px 6px -1px rgba(0, 0, 0, 0.3), 0 2px 4px -1px rgba(0, 0, 0, 0.2)";
                                }}
                                title="Open Whiteboard"
                                aria-label="Open whiteboard"
                            >
                                <PenSquare size={20} />
                            </button>
                        )}
                        <button
                         style={{
                            width:"3rem",
                            height:"3rem",
                            borderRadius:"0.75rem",
                            backgroundColor:"rgba(239, 68, 68, 0.9)",
                            border:"1px solid rgba(220, 38, 38, 0.3)",
                            color:"white",
                            display:"flex",
                            alignItems:"center",
                            justifyContent:"center",
                            cursor:"pointer",
                            transition:"all 0.2s ease-in-out",
                            boxShadow:"0 4px 6px -1px rgba(0, 0, 0, 0.3), 0 2px 4px -1px rgba(0, 0, 0, 0.2)"
                         }}
                         onClick={(e)=>{handleLeaveMeeting()}}
                         onMouseEnter={(e) => {
                            e.currentTarget.style.backgroundColor = "rgba(220, 38, 38, 1)";
                            e.currentTarget.style.transform = "scale(1.05)";
                            e.currentTarget.style.boxShadow = "0 6px 8px -1px rgba(0, 0, 0, 0.4), 0 4px 6px -1px rgba(0, 0, 0, 0.3)";
                         }}
                         onMouseLeave={(e) => {
                            e.currentTarget.style.backgroundColor = "rgba(239, 68, 68, 0.9)";
                            e.currentTarget.style.transform = "scale(1)";
                            e.currentTarget.style.boxShadow = "0 4px 6px -1px rgba(0, 0, 0, 0.3), 0 2px 4px -1px rgba(0, 0, 0, 0.2)";
                         }}
                         >
                            <PhoneOff size={20} />
                         </button>
                    </div>
                </div>

            </>
        }
    </>
}