// playerRealTime.ts
// Supabase realtime networking for player positions.
// - Connects to a room channel
// - Throttles + broadcasts local positions
// - Broadcasts player meta (name, character, avatar) on join & on meta-requests
// - Handshakes: new client sends "meta-req", others reply with "player-meta"
// - Receives remote positions -> per-player bounded queues
// - Exposes queues + meta + subscription helpers


import { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "@/utils/supabase/client";
import { Dispatch, SetStateAction, useCallback } from "react";
import { EventEmitter } from 'events';

import { off } from "process";
import { TruckElectric } from "lucide-react";
import { error } from "console";

if (typeof window !== "undefined") {
 window.addEventListener("popstate",async ()=>{
  await destroyRealtime();
 })
 window.addEventListener("beforeunload",async ()=>{
  await destroyRealtime();
 })
}



export type PlayerMeta = {
  userId: string;
  name?: string;
  character?: string;
  avatar?: string;
};


export type PlayerPosPayload = {
  userId: string;
  x: number;
  y: number;
  ts: number;
  name?: string;
  character?: string;
  avatar?: string;
};

type PositionSample = { x: number; y: number; ts: number };
type QueueMap = Map<string, PositionSample[]>;
type PlayerMetaInfo = { name?: string; character?: string; avatar?: string; status?: 'afk' | 'active' };

export type ChatMessage = {
  id: string; // Unique message ID
  senderId: string;
  senderName?: string;
  message: string;
  timestamp: number;
};

// --- State ---
let channel: RealtimeChannel | null = null;
let roomIdRef: string | null = null;
let playerIdRef: string | null = null;
let myMetaRef: PlayerMetaInfo = {};

const positionQueues: QueueMap = new Map();
const metaCache = new Map<string, PlayerMetaInfo>();
const chatMessageSubscribers = new Set<(message: ChatMessage) => void>();
const lastSeen = new Map<string, number>();

// Subscribers
type UpdateCb = (playerId: string, pos: PositionSample) => void;
const updateSubscribers = new Set<UpdateCb>();
const metaSubscribers = new Set<(playerId: string, meta: PlayerMetaInfo) => void>();


// --- Throttle ---
const SEND_HZ = 15;
const SEND_INTERVAL_MS = Math.floor(1000 / SEND_HZ);
let lastSentAt = 0;
let lastPending: { x: number; y: number } | null = null;
let sendTimer: ReturnType<typeof setTimeout> | null = null;

let PROXIMITY_DISTANCE=100

export function getMyId(){return playerIdRef}

// --- AFK API ---
export function setAFKStatus(afk: boolean) {
  myMetaRef = { ...myMetaRef, status: afk ? 'afk' : 'active' };
  if (playerIdRef) {
    safeSend("player-meta", { playerId: playerIdRef, ...myMetaRef });
  }
}

//Webrtc related
export type MediaComponentTtype={
  track:MediaStream
  from:string,
}
export type dataChannelStatusType={
  muted:boolean,
  mode:ModeType
}

export const MODE={
  "PROXIMITY":0,
  "MEETING":1 
}
export type ModeType = typeof MODE[keyof typeof MODE]

export type participantType={
  id:string,
  mode:ModeType,
  stream:MediaStream | null
}
class ParticipantState{
  mode:ModeType
  stream:MediaStream | null
  initialOfferState:boolean
  name:string | null
  callStream:MediaStream | null;
  callerName:null | string
  callerId:null | string
  callerService:null | CallerService
  constructor(){
    this.mode=MODE.PROXIMITY
    this.stream=null
    this.initialOfferState=false
    this.name=null
    this.callStream=null
    this.callerName=null
    this.callerId=null
    this.callerService=null
  }
}
export const currentState=new ParticipantState()
export function setCurrentStateName(n:string){
  currentState.name=n
}
export function setModeState(a:ModeType=currentState.mode){
  currentState.mode=a;
  for( const [key,value] of peersConnections){
    const Peer:PeerService=value
    const ch=Peer.dataChannels.get("mode");
    
  }
}
export function setStreamState(s:MediaStream){
  currentState.stream=s;
}
let setMode:null | React.Dispatch<React.SetStateAction<number>>=null
let setParticipants:null | React.Dispatch<React.SetStateAction<participantType[]>>=null;
let setUserNames:null | React.Dispatch<React.SetStateAction<{
    [id: string]: string;
}>>
let setIsMeeting:null | React.Dispatch<React.SetStateAction<boolean>> =null
let setShowInviteNotification:null | React.Dispatch<React.SetStateAction<boolean>> =null
let setShowCallNotification:null | React.Dispatch<React.SetStateAction<boolean>> =null
let setCallerName:null | React.Dispatch<React.SetStateAction<{name:string,id:string} | null>> =null
let setShowJoinRequestNotification:null | React.Dispatch<React.SetStateAction<{name:string,id:string} | null>> =null


export function registerSetMode(setState:null | React.Dispatch<React.SetStateAction<number>>){
  setMode=setState
}
export function registerSetParticipants(setState:null | React.Dispatch<React.SetStateAction<participantType[]>>){
  setParticipants=setState
}
export function registerSetUserNames(setState:null | React.Dispatch<React.SetStateAction<{
    [id: string]: string;
}>>){
  setUserNames=setState
}
export function registerSetIsMeeting(setState:null | React.Dispatch<React.SetStateAction<boolean>>){
  setIsMeeting=setState
}
export function registerSetShowInviteNotification(setState:null | React.Dispatch<React.SetStateAction<boolean>>){
  setShowInviteNotification=setState
}
export function registerSetShowCallNotification(setState:null | React.Dispatch<React.SetStateAction<boolean>>){
  setShowCallNotification=setState
}
export function registerSetCallerName(setState:null | React.Dispatch<React.SetStateAction<{name:string,id:string} | null>>){
  setCallerName=setState
}
export function registerSetShowJoinRequestNotification(setState:null | React.Dispatch<React.SetStateAction<{name:string,id:string} | null>>){
  setShowJoinRequestNotification=setState
}
export type PlayerInfo = { id: string; name?: string; character?: string; avatar?: string,mode?:ModeType }

export const RTCCallerEventEmitter = new EventEmitter();
class CallerService{
  name:null | string
  id:string | null
  queue:any[] 
  peer:RTCPeerConnection
  state:boolean
  constructor(id:string,name:string){
    this.name=name;
    this.id=id;
    this.queue=[];
    this.peer= new RTCPeerConnection();
    this.state=false

    this.peer.onicecandidate=(e)=>{
         if(!e.candidate){return}
    
         channel?.send({type:"broadcast",event:"Caller-Webrtc-ICE",payload:{from:playerIdRef,to:currentState.callerId,ICE:JSON.stringify(e.candidate)}})
    }
      this.peer.ontrack=(event)=>{
        console.log("peer ontrack event in CallerService:\n\n",event)
        
        
          RTCCallerEventEmitter.emit("onCallerTrack",event.track)
      
       
      }
  }
  async getOffer(){

    const offer = await this.peer.createOffer();
    await this.peer.setLocalDescription(offer)
    return offer;
  }
  async getAnswer(o:RTCSessionDescriptionInit){
    // Validate the offer before using it
    if (!o || !o.type || !o.sdp) {
      throw new Error("Invalid offer: missing type or sdp");
    }
    
    const offer = new RTCSessionDescription({
      type: o.type,
      sdp: o.sdp
    });
    
    await this.peer.setRemoteDescription(offer);
    const answer = await this.peer.createAnswer();
    await this.peer.setLocalDescription(answer);
    
    this.state=true
      this.queue.forEach(async (ICE)=>{
        try{
        await this.peer?.addIceCandidate(new RTCIceCandidate(ICE))
        }catch(e){console.error("Problem occured while addinf ICE in CallerService")}
      })
      this.queue=[]

      return answer;
  }
    async setLocal(ACK:RTCSessionDescriptionInit){
    if(this.peer){
      // Validate the answer before using it
      if (!ACK || !ACK.type || !ACK.sdp) {
        throw new Error("Invalid answer: missing type or sdp");
      }
      
      await this.peer.setRemoteDescription(new RTCSessionDescription({
        type: ACK.type,
        sdp: ACK.sdp
      }))
      this.state=true
      this.queue.forEach(async (ICE)=>{
         try{
          await this.peer?.addIceCandidate(new RTCIceCandidate(ICE))
            console.log("ICE actually added")
          }catch(e){console.error("Problem occured while addinf ICE")}
      })
      this.queue=[]
    }
  }
  async addICECandidates(ICE:RTCIceCandidate){
    if(!this.state){
      this.queue.push(ICE)
    }
    else{
      try{
      await this.peer.addIceCandidate(new RTCIceCandidate(ICE))
      console.log("ICE actually added")
      }catch(e){console.error("Problem occured while addinf ICE")}

    }
    
  }
  close(){
    this.peer.getSenders().forEach((s)=>{s.track?.stop()})
    this.peer.close()
  }
}
let setMyStreamCaller:Dispatch<SetStateAction<MediaStream | null>> | null=null;
export function  registerSetMyStreamCaller(setState:Dispatch<SetStateAction<MediaStream | null>> | null){
  setMyStreamCaller=setState;
}
export async function setCurrentStateStream(s:MediaStream){
  currentState.callStream=s;
  currentState.callerService=new CallerService(currentState.callerId!,currentState.callerName!);
  const Peer=currentState.callerService;
  s.getTracks().forEach((t)=>{Peer.peer.addTrack(t,s)});
  const offer = await Peer.getOffer();

  channel?.send({type:"broadcast",event:"Call-Accepted",payload:{from:playerIdRef,to:currentState.callerId,name:currentState.name,sdp:offer}})
}
export const RTCEventEmitter=new EventEmitter();


function onModeDataChannelMessage(a:string,obj:PeerService){
  
    
     const myData=JSON.parse(a) as {mode:ModeType}
      obj.mode=myData.mode
      if(setParticipants){
        setParticipants((prev)=>{
          let IsPresent=false;
          prev.forEach((p)=>{
            if(p.id===obj.from){
              p.mode=myData.mode;
              IsPresent=true
            }
          });
          
            return [...prev];
         
        })
      }else{throw new Error("setparticipants not defined yet")}
  
}
let userNameState=false;
let pendingFunction:string | null=null
export function broadCastUserNames(n:string){
 
    if(!userNameState){
      userNameState=true
    }
    else{
      pendingFunction=n
    } 
}
export function broadcastMeetingState(a:boolean, hostId?: string){
  channel?.send({type:"broadcast",event:"meetingChange",payload:{flag:a, hostId: hostId || playerIdRef}})
}
export function broadcastCallLeave(){
  if (currentState.callerId) {
    channel?.send({type:"broadcast",event:"Call-Ended",payload:{from:playerIdRef,to:currentState.callerId}})
    // Broadcast that call has ended
    broadcastCallState(playerIdRef!, currentState.callerId, false);
  }
}

export function broadcastCallState(callerId: string, receiverId: string, inCall: boolean) {
  if (!channel || !playerIdRef) return;
  channel.send({
    type: "broadcast",
    event: "call-state-change",
    payload: {
      callerId: callerId,
      receiverId: receiverId,
      inCall: inCall
    }
  });
}
export function handleMute(flag:boolean){
  for(const [key,value] of peersConnections){
    const Peer=value;
    if(Peer.mode===MODE.MEETING){
      Peer.peer?.getSenders().forEach((s)=>{
        if(s.track && s.track.kind === "audio"){
          s.track.enabled=!flag;
        }
      })
    }
  }
}
// Invite notification functions
export function sendMeetingInvite(to: string) {
  if (!channel || !playerIdRef) return;
  channel.send({
    type: "broadcast",
    event: "meeting-invite",
    payload: {
      from: playerIdRef,
      to: to
    }
  });
}

export function sendJoinMeetingRequest(to: string, requesterName: string) {
  if (!channel || !playerIdRef) return;
  channel.send({
    type: "broadcast",
    event: "join-meeting-request",
    payload: {
      from: playerIdRef,
      to: to,
      requesterName: requesterName
    }
  });
}

export function sendJoinMeetingResponse(to: string, accepted: boolean) {
  if (!channel || !playerIdRef) return;
  channel.send({
    type: "broadcast",
    event: "join-meeting-response",
    payload: {
      from: playerIdRef,
      to: to,
      accepted: accepted
    }
  });
}
export function setCurrentStateInfo(a:null){
  
    currentState.callStream=null;
    currentState.callerId=null;
    currentState.callerName=null;
    currentState.callerService=null;
    
 
}

export function sendCallNotification(to: string) {
  if (!channel || !playerIdRef) return;
  const callerName = currentState.name || "Someone";
  channel.send({
    type: "broadcast",
    event: "call-notification",
    payload: {
      from: playerIdRef,
      to: to,
      callerName: callerName,
      callerId: playerIdRef
    }
  });
}

type RTCBroadcastType={
    from:string | null,
    to:string,
    sdp:RTCSessionDescriptionInit|undefined
}
type ICEBroadcastType={
  from:string,
  to:string,
  ICE:string
}

class PeerService{
  peer:undefined|RTCPeerConnection
  queue:any[]
  state:boolean
  senders:(RTCRtpSender|undefined)[]
  targetId:string
  mode:ModeType
  from:string
  name:string | null
  dataChannels:Map<string,RTCDataChannel>
  trackState:boolean
  constructor(from:string,m:ModeType){
    this.from=from
    this.targetId = from
    this.senders=[]
    this.queue=[]
    this.state=false
    this.mode=m
    this.dataChannels=new Map<string,RTCDataChannel>()
    this.name=null
    this.trackState=false
    if(!this.peer){
      this.peer=new RTCPeerConnection({
      
      iceServers: [
        {
          urls: [
            'stun:stun.l.google.com:19302',
            'stun:global.stun.twilio.com:3478',
        
          ],
        },
      ]
      
    });
      this.peer.ondatachannel=(e)=>{
        const ch:RTCDataChannel=e.channel;

        if(ch.label==="mode"){
          this.dataChannels.set("mode",ch)
          ch.onmessage=(e)=>{
            onModeDataChannelMessage(e.data,this)
           
          }
        }
        else if(ch.label==="mute"){
          this.dataChannels.set("mute",ch)
          ch.onmessage=(e)=>{

          }
        }
        

      }
      this.peer.onicecandidate=(e)=>{
         if(!e.candidate){return}
         if(!from){
          console.error("from not defined in constructor")
          return;
         }
         
         console.log("sending ICE to:", from)
         channel?.send({type:"broadcast",event:"webrtc-ICE",payload:{from:playerIdRef,to:from,ICE:JSON.stringify(e.candidate)}})
      }
      this.peer.ontrack=(event)=>{
        console.log("peer ontrack event:\n\n",event)
        if(!currentState.stream){throw new Error("CurrentState.stream not defined in peer.ontrack EventListner")}
        if(this.mode===MODE.MEETING){
          RTCEventEmitter.emit("onMeetingTrack",this.from,event.track,this.mode,this.trackState)
          this.trackState=!this.trackState;
        }
        else{
          RTCEventEmitter.emit("onTrack",this.from,event.track,this.mode)  
        }
      }
      this.peer.onconnectionstatechange=()=>{
        if(this.peer){
          console.log(`[${this.from}] Connection state changed to: ${this.peer.connectionState}`)
          if(this.peer.connectionState === 'disconnected' || this.peer.connectionState === 'failed' || this.peer.connectionState === 'closed'){
            // Emit event to remove participant
            RTCEventEmitter.emit("onParticipantDisconnect", this.from)
          }
        }
      }
    }
  }
  async getOffer(){
    if(this.peer){
      if(this.dataChannels.size===0){
        const d1=this.peer.createDataChannel("mode")
        const d2=this.peer.createDataChannel("mute")
        
        d1.onmessage=(e)=>{
           onModeDataChannelMessage(e.data,this)
        }
        d2.onmessage=(e)=>{}
       
        this.dataChannels.set("mode",d1)
        this.dataChannels.set("mute",d2)
      }
      const offer=await this.peer.createOffer()
      await this.peer.setLocalDescription(new RTCSessionDescription(offer))
      return offer
    }
  }
  async getAnswer(offer:RTCSessionDescriptionInit){

    if(this.peer){
      // Remove existing tracks and add current stream tracks
      this.peer.getSenders().forEach((sender)=>{this.peer?.removeTrack(sender)});
      if(!currentState.stream){throw new Error("stream not defined in getAnswer method of PeerService")}
      currentState.stream.getTracks().forEach((track)=>{
        this.peer?.addTrack(track,currentState.stream!)
      })

      await this.peer.setRemoteDescription(new RTCSessionDescription(offer))

      const answer=await this.peer.createAnswer();
      await this.peer.setLocalDescription(new RTCSessionDescription(answer))
      this.state=true
      this.queue.forEach(async (ICE)=>{
        try{
        await this.peer?.addIceCandidate(new RTCIceCandidate(ICE))
          console.log("ICE actually added")
        }catch(e){console.error("Problem occured while addinf ICE")}
      })
      this.queue=[]

      return answer;
    }
  }
  async setLocal(ACK:RTCSessionDescriptionInit){
    if(this.peer){
      // Check connection state before setting remote description
      const currentState = this.peer.signalingState;
      console.log(`[SET LOCAL] Current signaling state: ${currentState}`);
      
      // Validate the answer before using it
      if (!ACK || !ACK.type || !ACK.sdp) {
        throw new Error("Invalid answer: missing type or sdp");
      }
      
      // Only set remote description if we're in the right state
      // We should be in "have-local-offer" state to set a remote answer
      if (currentState === "have-local-offer" || currentState === "stable") {
        try {
          await this.peer.setRemoteDescription(new RTCSessionDescription({
            type: ACK.type,
            sdp: ACK.sdp
          }));
          this.state=true;
          
          // Process queued ICE candidates
          this.queue.forEach(async (ICE)=>{
            try {
              await this.peer?.addIceCandidate(new RTCIceCandidate(ICE));
              console.log("ICE actually added");
            } catch(e) {
              console.error("Problem occurred while adding ICE:", e);
            }
          });
          this.queue=[];
        } catch (error) {
          console.error(`[SET LOCAL] Error setting remote description in state ${currentState}:`, error);
        }
      } else {
        console.warn(`[SET LOCAL] Cannot set remote description in state: ${currentState}`);
      }
    }
  }
  async addICECandidates(ICE:RTCIceCandidate){
    if(!this.state){
      this.queue.push(ICE)
    }
    else{
      try{
      await this.peer?.addIceCandidate(new RTCIceCandidate(ICE))
      console.log("ICE actually added")
      }catch(e){console.error("Problem occured while addinf ICE")}

    }
    
  }
  close(){
    this.peer?.getSenders().forEach((s)=>{s.track?.stop()})
    this.peer?.close()
  }
}

const peersConnections=new Map<string,PeerService>()

export async function renegotiate(s:MediaStream,m:ModeType){
  for(let [key,value] of peersConnections){
    const Peer=value;
    const senders=Peer.peer?.getSenders()
    senders?.forEach((sender)=>{Peer.peer?.removeTrack(sender)})
    s.getTracks().forEach((t)=>{Peer.peer?.addTrack(t,s)})
    const offer=await Peer.getOffer();
    if(offer){
      channel?.send({type:"broadcast",event:"renegotiation-initials",payload:{from:playerIdRef,to:Peer.from,sdp:offer,mode:m}})
    }
    else{console.error("problem creating offer")}
  }
  
}

export async function createInitialOffer(participantId:string){
  
  if(currentState.stream){
    const Peer=peersConnections.get(participantId)
      if(Peer && Peer.mode==MODE.PROXIMITY){
      if(!currentState.stream){throw new Error('currentState stream is NULL in  createInitialOffer')}
      currentState.stream.getTracks().forEach((track)=>{
        if(!currentState.stream){throw new Error('currentState stream is NULL in createInitialOffer')}
        Peer.peer?.addTrack(track,currentState.stream)
      })
    
        const offer= await Peer.getOffer()
        if(offer){
          channel?.send({type:"broadcast",event:"webrtc-initials",payload:{from:playerIdRef,to:Peer.from,sdp:offer}})
        }
        else{throw new Error("offer not defined in createInitialOffer method")}
    }
    else{
      if(!Peer){
        throw new Error("Peer is not defined in createInitialOffer")
      }
    }
  }
else{throw new Error('currentState stream is NULL in createInitialOffer')}
}

export function broadcastModeChange(m:ModeType){
  
    for(const [key,value] of peersConnections){
      const Peer:PeerService=value;
      Peer.dataChannels.get("mode")?.send(JSON.stringify({mode:m})) 
    }
  
}




// --- Utils ---
function pushToQueue(playerId: string, sample: PositionSample) {
  const q = positionQueues.get(playerId) ?? [];
  q.push(sample);
  if (q.length > 8) q.shift();
  positionQueues.set(playerId, q);
}

function safeSend(event: string, payload: Record<string, any>) {
  if (!channel) return;
  try {
    channel.send({ type: "broadcast", event, payload });
  } catch {}
}
function rtcSafeSend(event:string,payload:RTCBroadcastType){
 if (!channel) return;
  try {
    channel.send({ type: "broadcast", event, payload });
  } catch {}
}
function getDistance(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}




// --- Init / Realtime setup ---
export async function initRealtime(opts: {
  roomId: string;
  playerId: string;
  meta?: PlayerMetaInfo;
}): Promise<void> {
  const { roomId, playerId, meta } = opts;
  roomIdRef = roomId;
  playerIdRef = playerId;
  myMetaRef = { ...(meta ?? {}) };
  
  
  // unsubscribe if previous channel existed
  if (channel) {
    try {
      await channel.unsubscribe();
    } catch {}
  }
  channel = null;
  
  channel = supabase.channel(`room:${roomId}`, {
    config: { broadcast: { self: false } },
  });

// WebRTC related


channel.on("broadcast", { event: "Call-Accepted" }, async ({ payload }) => {
const data = payload as { from: string; to: string; name:string ,sdp?:RTCSessionDescriptionInit, offer?:RTCSessionDescriptionInit};

  if (!data.from || data.from === playerIdRef) return;
  if (data.to === playerIdRef) {
    currentState.callerId=data.from;
    currentState.callerName=data.name;
    currentState.callerService=new CallerService(data.from,data.name);
    
    // Add safety check
    if (typeof window === 'undefined' || !navigator?.mediaDevices?.getUserMedia) {
      console.error('getUserMedia is not available');
      return;
    }
    
    const newStream=await navigator.mediaDevices.getUserMedia({video:true,audio:true})
    setMyStreamCaller!(newStream);
    const Peer=currentState.callerService;
    newStream.getTracks().forEach((t)=>{Peer.peer.addTrack(t,newStream)});
    
    // Handle both 'offer' and 'sdp' field names for compatibility
    const offer = data.offer || data.sdp;
    if (!offer) {
      console.error("Call-Accepted: Missing offer/sdp in payload");
      return;
    }
    
    const answer = await Peer.getAnswer(offer);
    
    channel?.send({type:"broadcast",event:"Call-Accepted-ACK",payload:{from:playerIdRef,to:currentState.callerId,sdp:answer}})
    // Broadcast that call is active (receiver accepted, waiting for ACK)
    // We'll also broadcast in Call-Accepted-ACK, but this ensures state is set early
    broadcastCallState(data.from, playerIdRef, true);
  }
});
channel.on("broadcast", { event: "Call-Accepted-ACK" }, async ({ payload }) => {
const data = payload as { from: string; to: string ,answer?:RTCSessionDescriptionInit, sdp?:RTCSessionDescriptionInit};

  if (!data.from || data.from === playerIdRef) return;
  if (data.to === playerIdRef) {
    // Handle both 'answer' and 'sdp' field names for backward compatibility
    const answer = data.answer || data.sdp;
    if (!answer) {
      console.error("Call-Accepted-ACK: Missing answer/sdp in payload");
      return;
    }
    
    await currentState.callerService!.setLocal(answer);
    // Broadcast that call is active (caller and receiver are in call)
    broadcastCallState(data.to, data.from, true);
    
  }
});

channel.on("broadcast", { event: "Call-Ended" }, async ({ payload }) => {
  const data = payload as {from:string,to:string}

  if (!data.from || data.from === playerIdRef) return;
  if (data.to === playerIdRef) {
    RTCCallerEventEmitter.emit("onCallLeave")
    // Broadcast that call has ended
    broadcastCallState(data.from, data.to, false);
  }
})

// Call state change listener
channel.on("broadcast", { event: "call-state-change" }, async ({ payload }) => {
  const data = payload as { callerId: string; receiverId: string; inCall: boolean };
  if (!data.callerId || !data.receiverId) return;
  // Emit event so components can track call state
  RTCEventEmitter.emit("call-state-change", data);
});
channel.on("broadcast", { event: "Caller-Webrtc-ICE" }, async ({ payload }) => {
const data = payload as { from: string; to: string ,ICE:string};

  if (!data.from || data.from === playerIdRef) return;
  if (data.to === playerIdRef) {
    
    currentState.callerService!.addICECandidates(JSON.parse(data.ICE))
    
  }
});


channel.on("broadcast",{event : "onModeChange"},async ({payload})=>{
  const data=payload as {from:string, mode:ModeType};
  if(!data.from || data.from===playerIdRef) return ;
  const Peer = peersConnections.get(data.from);
  if(!Peer){throw new Error("Peer not defined in recieving Mode change.")}
  Peer.mode=data.mode
});

channel.on("broadcast",{event:"onUserName"}, async ({payload})=>{
  const data = payload as {from:string,name:string};
  if(!data.from || data.from===playerIdRef){return;}
  
  const Peer=peersConnections.get(data.from);
  if(!Peer){throw new Error("Peer not defined")}
  Peer.name=data.name;
  if(!setUserNames){throw new Error("setusername not defioned")}
  setUserNames((prev)=>{
  
      let ans= {...prev}
      ans[Peer.from]=data.name;
      return ans;
    })
    setParticipants!((p)=>{
      return [...p]
    })
    channel?.send({type: "broadcast",event: "onUserName-ACK",payload: { from: playerIdRef, to: data.from,name:currentState.name}});
})
channel.on("broadcast",{event : "onUserName-ACK"},async({payload})=>{
  const data = payload as {from:string,to:string,name:string}
  if(!data.from || data.from===playerIdRef){return;}
  if(data.to!==playerIdRef){return}
  setUserNames!((prev)=>{
    let ans={...prev};
    ans[data.from]=data.name
    return ans
  })
});
channel.on("broadcast",{event:"meetingChange"},async({payload})=>{
  const data= payload as {flag:boolean, hostId?: string}
  if(!setIsMeeting){throw new  Error("setIsMeeting not defined")}
  setIsMeeting(data.flag)
  // Emit event with host ID if provided
  if (data.flag && data.hostId) {
    RTCEventEmitter.emit("meeting-started", data.hostId);
  } else if (!data.flag) {
    RTCEventEmitter.emit("meeting-ended");
  }
});

// Meeting invite notifications
channel.on("broadcast", { event: "meeting-invite" }, async ({ payload }) => {
  const data = payload as { from: string; to: string };
  if (!data.from || data.from === playerIdRef) return;
  if (data.to === playerIdRef) {
    if(setShowInviteNotification){
      setShowInviteNotification(true);
    }
  }
});

// Join meeting request notifications
channel.on("broadcast", { event: "join-meeting-request" }, async ({ payload }) => {
  const data = payload as { from: string; to: string; requesterName: string };
  if (!data.from || data.from === playerIdRef) return;
  if (data.to === playerIdRef) {
    if(setShowJoinRequestNotification){
      setShowJoinRequestNotification({
        name: data.requesterName || "Someone",
        id: data.from
      });
    }
  }
});

// Join meeting response notifications
channel.on("broadcast", { event: "join-meeting-response" }, async ({ payload }) => {
  const data = payload as { from: string; to: string; accepted: boolean };
  if (!data.from || data.from === playerIdRef) return;
  if (data.to === playerIdRef) {
    if (data.accepted) {
      // The request was accepted, trigger join meeting
      RTCEventEmitter.emit("join-meeting-accepted");
    } else {
      // The request was rejected
      RTCEventEmitter.emit("join-meeting-rejected");
    }
  }
});

// Call notifications
channel.on("broadcast", { event: "call-notification" }, async ({ payload }) => {
  const data = payload as { from: string; to: string; callerName: string; callerId: string };
  if (!data.from || data.from === playerIdRef) return;
  if (data.to === playerIdRef) {
    if(setShowCallNotification){
      setShowCallNotification(true);
    }
    if(setCallerName){
      setCallerName({
        name: data.callerName || "Someone",
        id: data.callerId || data.from
      });
    }
    currentState.callerName=data.callerName;
    currentState.callerId=data.callerId;
  }
});

channel.on("broadcast", { event: "webrtc-meta" }, async ({ payload }) => {
  const data = payload as { from: string ,mode:ModeType};
  
  if (!data.from || data.from === playerIdRef) return;
  
    if (!peersConnections.has(data.from)) {
      peersConnections.set(data.from, new PeerService(data.from,data.mode));
      
      const Participant:participantType={id:data.from,mode:data.mode,stream:null}
      RTCEventEmitter.emit("onParticipant",Participant)
    }

setIsMeeting!((prev)=>{

  channel?.send({type:"broadcast",event:"meetingChange",payload:{flag:prev}})
  return prev;
})

  channel?.send({
    type: "broadcast",
    event: "webrtc-meta-ACK",
    payload: { from: playerIdRef, to: data.from,mode:currentState.mode ,name:currentState.name},
  });
});

channel.on("broadcast", { event: "webrtc-meta-ACK" }, async ({ payload }) => {
  const data = payload as { from: string; to: string ,mode:ModeType, name:string};
  
  if (!data.from || data.from === playerIdRef) return;
  if (data.to === playerIdRef) {
    
    if (!peersConnections.has(data.from)) {
      peersConnections.set(data.from, new PeerService(data.from,data.mode));

      const Participant:participantType={id:data.from,mode:data.mode,stream:null}
      RTCEventEmitter.emit("onParticipant",Participant)
    }
    await createInitialOffer(data.from)
  }
});


channel.on("broadcast", { event: "renegotiation-initials" }, async ({ payload }) => {
 const data = payload as { from: string; to: string; sdp: RTCSessionDescriptionInit,mode:ModeType };
  
  if (!data.from || data.from === playerIdRef) return;
  if (data.to === playerIdRef) {
    const Peer = peersConnections.get(data.from);
    const answer = await Peer?.getAnswer(data.sdp);
    if(currentState.mode!==data.mode){return;}
    channel?.send({type:"broadcast",event:"webrtc-initials-ACK" ,payload:{from:playerIdRef,to:Peer?.from,sdp:answer,mode:data.mode}})
    
  }
});

channel.on("broadcast", { event: "webrtc-initials" }, async ({ payload }) => {
  const data = payload as { from: string; to: string; sdp: RTCSessionDescriptionInit };
  console.log("event: webrtc-initials(new user just joined)", data);
  if (!data.from || data.from === playerIdRef) return;
  if (data.to === playerIdRef) {
    
    const Peer = peersConnections.get(data.from);
    const answer = await Peer?.getAnswer(data.sdp);
    rtcSafeSend("webrtc-initials-ACK", { from: playerIdRef, to: data.from, sdp: answer });
  }
});

channel.on("broadcast", { event: "webrtc-initials-ACK" }, ({ payload }) => {
  const data = payload as { from: string; to: string; sdp: RTCSessionDescriptionInit,mode?:ModeType };
  if (!data.from || data.from === playerIdRef) return;
  if (data.to === playerIdRef) {
    const Peer = peersConnections.get(data.from);
    if (!Peer || !Peer.peer) {
      console.error(`[WEBRTC-ACK] Peer not found for ${data.from}`);
      return;
    }
    
    // Check state before setting
    const currentState = Peer.peer.signalingState;
    console.log(`[WEBRTC-ACK] Current state for ${data.from}: ${currentState}`);
    
    if (currentState === "have-local-offer") {
      Peer.setLocal(data.sdp);
      console.log("ACK received:", data.from);
      if(data.mode){return}
      if(userNameState){
        channel?.send({type:"broadcast",event:"onUserName",payload:{from:playerIdRef,name:pendingFunction}})
      }
      else{
        userNameState=true;
      }
    } else {
      console.warn(`[WEBRTC-ACK] Cannot set local description in state: ${currentState}`);
    }
  }
});
channel.on("broadcast",{event:"webrtc-destroy"},({payload})=>{
  const data = payload as { from: string}
  console.log("WebRTC peer destroyed ",data.from)
    peersConnections.get(data.from)?.close()
    peersConnections.delete(data.from)
    setParticipants!((prev)=>{
      const ans= prev.filter((p)=>{p.id!==data.from})
    return ans
    })
})
channel.on("broadcast",{event:"webrtc-ICE"},async ({payload})=>{
  
  const data= payload as ICEBroadcastType
  if(!data.from || data.from==playerIdRef){return ;}
  if(data.to===playerIdRef){
      const Peer=peersConnections.get(data.from);
      console.log("Inside supabase webrtc ICE revieveng Event"+data.ICE)
      if(Peer?.peer && data.ICE){
        try{
        await Peer.addICECandidates(JSON.parse(data.ICE))
         console.log("Ice recieved and sent to Peer Service")
        }catch(e){console.error("Problem oiccures while Sending ICE to Peer Service")}
      }
  }
})


  // --- Position updates ---
  channel.on("broadcast", { event: "player-pos" }, (payload) => {
    const data = payload.payload as { playerId: string; x: number; y: number; ts?: number };
    if (!data?.playerId || data.playerId === playerIdRef) return;
    lastSeen.set(data.playerId, Date.now());
    const sample: PositionSample = { x: data.x, y: data.y, ts: data.ts ?? Date.now() };
    pushToQueue(data.playerId, sample);
    updateSubscribers.forEach((cb) => cb(data.playerId, sample));
    
    if(playerIdRef){
      const myPosition = positionQueues.get(playerIdRef);
  
  if (myPosition && myPosition.length > 0) {
    const myLatestPos = myPosition[myPosition.length - 1];
    const distance = getDistance(myLatestPos, { x: data.x, y: data.y });
  
    

//  add prooximity logic here
    
   
    const element:HTMLMediaElement|null=document.querySelector(".AudioElement"+data.playerId)
    if(element){
      element.muted=distance>PROXIMITY_DISTANCE
    }
    else{
      
    }

  }
    }
    
  });
  

  
  // --- Meta updates ---
  channel.on("broadcast", { event: "player-meta" }, (payload) => {
    const data = payload.payload as { playerId: string; name?: string; character?: string; avatar?: string };
    if (!data?.playerId || data.playerId === playerIdRef) return;
    lastSeen.set(data.playerId, Date.now());
    const next: PlayerMetaInfo = { name: data.name, character: data.character, avatar: data.avatar, status: (payload.payload as any)?.status };
    metaCache.set(data.playerId, next);
    metaSubscribers.forEach((cb) => cb(data.playerId, next));
    
  
  });
  
  
  // --- Chat messages ---
  channel.on("broadcast", { event: "chat-message" }, (payload) => {
    const message = payload.payload as ChatMessage;
    chatMessageSubscribers.forEach((cb) => cb(message));
  });
  
  // --- Meta request (handshake) ---
  channel.on("broadcast", { event: "meta-req" }, (payload) => {
    const data = payload.payload as { from?: string };
    if (data?.from && data.from === playerIdRef) return;
    if (playerIdRef) {
      safeSend("player-meta", { playerId: playerIdRef, ...myMetaRef });
    }
  });
  
  // --- Subscribe ---
  await channel.subscribe(async (status) => {
    if (status === "SUBSCRIBED") {
      // send meta so others learn about us
      if (myMetaRef && (myMetaRef.name || myMetaRef.character || myMetaRef.avatar)) {
        sendPlayerMeta(myMetaRef);
      }
      safeSend("meta-req", { from: playerIdRef });
      startSignaling()
    
      
    }
  });
  
  // --- Periodic cleanup of stale players ---
  setInterval(() => {
    const now = Date.now();
    const TIMEOUT = 10000; // 10 seconds
    for (const [id, ts] of lastSeen.entries()) {
      if (id === playerIdRef) continue; // never remove self
      if (now - ts > TIMEOUT) {
        lastSeen.delete(id);
        metaCache.delete(id);
        positionQueues.delete(id);
      }
    }
  }, 2000);
}

// --- Sending ---
export function sendPosition(x: number, y: number) {
  if (!channel || !playerIdRef) return;
  const now = Date.now();
  
  // push own pos locally so proximity check has a reference
  pushToQueue(playerIdRef, { x, y, ts: now });
  
  if (now - lastSentAt >= SEND_INTERVAL_MS) {
    lastSentAt = now;
    lastPending = null;
    safeSend("player-pos", { playerId: playerIdRef, x, y, ts: now });
  } else {
    lastPending = { x, y };
    if (!sendTimer) {
      const wait = SEND_INTERVAL_MS - (now - lastSentAt);
      sendTimer = setTimeout(() => {
        sendTimer = null;
        if (!channel || !lastPending) return;
        const t = Date.now();
        safeSend("player-pos", { playerId: playerIdRef, x: lastPending.x, y: lastPending.y, ts: t });
        lastSentAt = t;
        lastPending = null;
      }, Math.max(0, wait));
    }
  }
   
}
export function startSignaling() {
  if(!currentState.initialOfferState){
    currentState.initialOfferState=true;
    return;
  }
    
  channel?.send({type:"broadcast",event:"webrtc-meta",payload:{from:playerIdRef,mode:currentState.mode}})
  console.log("signalinf start")
}

export function sendChatMessage(message: string) {
  if (!channel || !playerIdRef) return;
  const chatMessage: ChatMessage = {
    id: Math.random().toString(36).substring(2, 9), // Simple unique ID
    senderId: playerIdRef,
    senderName: myMetaRef.name,
    message,
    timestamp: Date.now(),
  };
  safeSend("chat-message", chatMessage);
}

export function sendPlayerMeta(meta: PlayerMetaInfo) {
  if (!channel || !playerIdRef) return;
  myMetaRef = { ...myMetaRef, ...meta };
  const payload = { playerId: playerIdRef, ...myMetaRef };
  safeSend("player-meta", payload);
  metaCache.set(playerIdRef, { ...metaCache.get(playerIdRef), ...myMetaRef });
}

// --- Subscriptions ---
export function onPlayerUpdate(cb: UpdateCb) {
  updateSubscribers.add(cb);
  return () => { updateSubscribers.delete(cb) }
}

export function onPlayerMeta(cb: (playerId: string, meta: PlayerMetaInfo) => void) {
  metaSubscribers.add(cb);
  return () => { metaSubscribers.delete(cb) }
}

export function onChatMessage(cb: (message: ChatMessage) => void) {
  chatMessageSubscribers.add(cb);
  return () => { chatMessageSubscribers.delete(cb) }
}

export function getPlayerMeta(playerId: string) {
  return metaCache.get(playerId);
}

// --- Queues ---
export function getPositionQueues() {
  return positionQueues as ReadonlyMap<string, ReadonlyArray<PositionSample>>;
}

export function popNextPosition(playerId: string) {
  const q = positionQueues.get(playerId);
  return q?.shift();
}

export function clearPlayerQueue(playerId: string) {
  positionQueues.delete(playerId);
}

export async function destroyRealtime() {
  channel?.send({type:"broadcast",event:"webrtc-destroy",payload:{from:playerIdRef}})
  peersConnections.forEach((Peer)=>{Peer.close()})
  peersConnections.clear();
  if (channel) {
    try {
      await channel.unsubscribe();
    } catch {}
  }
  channel = null;

  positionQueues.clear();
  updateSubscribers.clear();
  metaSubscribers.clear();
  metaCache.clear();
  lastPending = null;
  if (sendTimer) {
    clearTimeout(sendTimer);
    sendTimer = null;
  }
  
  // Clear chat subscribers
  chatMessageSubscribers.clear();

}

// --- Compatibility wrapper ---
export function createPlayerRealtime(options: {
  roomId: string;
  me: PlayerMeta;
  handlers?: {
    onPlayerPos?: (payload: PlayerPosPayload) => void;
    onPresenceSync?: (state: Record<string, any[]>) => void;
  };
}) {
  const { roomId, me, handlers } = options;

  void initRealtime({
    roomId,
    playerId: me.userId,
    meta: { name: me.name, character: me.character, avatar: me.avatar },
  }).then(() => {
    handlers?.onPresenceSync?.({});
  });

  const offUpdate = onPlayerUpdate((playerId, pos) => {
    if (playerId === me.userId) return;
    const meta = getPlayerMeta(playerId);
    handlers?.onPlayerPos?.({
      userId: playerId,
      x: pos.x,
      y: pos.y,
      ts: pos.ts,
      name: meta?.name,
      character: meta?.character,
      avatar: meta?.avatar,
    });
  });

  const offMeta = onPlayerMeta(() => {});

  return {
    broadcastPosition: (data: { x: number; y: number }) => sendPosition(data.x, data.y),
    destroy: async () => {
      offUpdate();
      offMeta();
      await destroyRealtime();
    },
    channel: null as any,
  };
}

// --- Utilities for UI ---
export function getAllPlayers(): Array<{ id: string; name?: string; character?: string; avatar?: string }> {
  const ids = new Set<string>();
  metaCache.forEach((_v, k) => ids.add(k));
  positionQueues.forEach((_v, k) => ids.add(k));
  if (playerIdRef) ids.add(playerIdRef);
  const out: Array<{ id: string; name?: string; character?: string; avatar?: string }> = [];
  ids.forEach((id) => {
    const meta = metaCache.get(id) ?? {};
    out.push({ id, name: meta.name, character: meta.character, avatar: meta.avatar });
  });
  return out;
}

export function getSelfId() { return playerIdRef; }
