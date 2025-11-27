'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useUser, useOrganization } from '@clerk/nextjs'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { getAllPlayers, getSelfId,sendCallNotification,registerSetShowCallNotification,registerSetCallerName,setCurrentStateStream
		 ,currentState,setCurrentStateInfo,registerSetMyStreamCaller,RTCCallerEventEmitter,broadcastCallLeave,RTCEventEmitter
		} from '@/game/realtime/PlayerRealtime'
import { Users2, MessageSquareText, Video, ChevronRight, ChevronLeft } from "lucide-react"
import TextChat from './TextChat'
import { getWhiteboardOpen } from '@/game/whiteboardState'
import DraggableVideo from './DraggableVideo'
import LeaveRoomButton from './LeaveRoomButton'
import { onChatMessage } from '@/game/realtime/PlayerRealtime'

type PlayerInfo = { id: string; name?: string; character?: string; avatar?: string }

type PlayersPanelProps = { inMeeting: boolean; setInMeeting: React.Dispatch<React.SetStateAction<boolean>>; roomId: string }

export default function PlayersPanel({ inMeeting, setInMeeting, roomId }: PlayersPanelProps) {
	const [players, setPlayers] = useState<PlayerInfo[]>([])
	const [activeTab, setActiveTab] = useState<'participants' | 'chat'>('participants')
	const [isWhiteboardOpen, setIsWhiteboardOpen] = useState(false)
	const [isCallNotification,setIsCallNotification]=useState<boolean>(false);
	const [callerInfo,setCallerInfo]=useState<{name:string,id:string} | null>(null);
	const [myStream,setMyStream] = useState<MediaStream | null>(null)
	const [callerStream,setCallerStream]= useState<MediaStream | null>(null);
	const [isOpen, setIsOpen] = useState(true)
	const [unreadCount, setUnreadCount] = useState(0)
	const selfId = getSelfId()
	const { user } = useUser()
	const { organization } = useOrganization()
	const [members, setMembers] = useState<Array<{ id: string; name: string; role: string; }>>([])
	const [activeCalls, setActiveCalls] = useState<Map<string, string>>(new Map()) // Map of playerId -> who they're in call with

	const refresh = useCallback(() => {
		const all = getAllPlayers()
		const filtered = all.filter((p) => p.id)
		setPlayers(filtered)
	}, [])

	useEffect(() => {
		refresh()
		const t = setInterval(refresh, 1000)
		return () => clearInterval(t)
	}, [refresh])

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
	}, [organization])

	// Unread chat counter
	useEffect(() => {
		const off = onChatMessage((message: any) => {
			// Ignore self messages
			if (message?.from === selfId) return
			// Increment only if chat tab not active
			if (activeTab !== 'chat') {
				setUnreadCount((c) => Math.min(99, c + 1))
			}
		})
		return () => { off && off() }
	}, [activeTab, selfId])

	// Reset unread when opening chat
	useEffect(() => {
		if (activeTab === 'chat') {
			setUnreadCount(0)
		}
	}, [activeTab])

	// Monitor whiteboard state
	useEffect(() => {
		const checkWhiteboardState = () => {
			setIsWhiteboardOpen(getWhiteboardOpen())
		}
		
		// Check immediately
		checkWhiteboardState()
		
		// Check periodically
		const interval = setInterval(checkWhiteboardState, 100)
		
		registerSetShowCallNotification(setIsCallNotification);
		registerSetCallerName(setCallerInfo);
		registerSetMyStreamCaller(setMyStream)
		RTCCallerEventEmitter.removeAllListeners("onCallerTrack")
		const handleCallerTrack = (track: MediaStreamTrack) => {
			setCallerStream((prev) => {
				if (!prev) {
					return new MediaStream([track]);
				}
				
				const existingTrack = prev.getTracks().find(t => t.id === track.id);
				if (existingTrack) {
					return prev; 
				}
				
				const newStream = new MediaStream();
				prev.getTracks().forEach(t => newStream.addTrack(t));
				newStream.addTrack(track);
				return newStream;
			});
		};
		RTCCallerEventEmitter.on("onCallerTrack", handleCallerTrack);
		return () => {
			clearInterval(interval);
			registerSetShowCallNotification(null);
			registerSetCallerName(null);
			registerSetMyStreamCaller(null)
			RTCCallerEventEmitter.removeAllListeners("onCallerTrack");
			setCallerStream(null);
			setMyStream(null)
		}
	}, [])
	RTCCallerEventEmitter.removeAllListeners("onCallLeave")
	RTCCallerEventEmitter.on("onCallLeave",()=>{
	
		setCallerStream(null);
	setCallerInfo(null);
	setCurrentStateInfo(null)
	})

	// Track call state changes
	useEffect(() => {
		const handleCallStateChange = (data: { callerId: string; receiverId: string; inCall: boolean }) => {
			setActiveCalls((prev) => {
				const newMap = new Map(prev);
				if (data.inCall) {
					// Add call: both participants are in call with each other
					newMap.set(data.callerId, data.receiverId);
					newMap.set(data.receiverId, data.callerId);
				} else {
					// Remove call: both participants are no longer in call
					newMap.delete(data.callerId);
					newMap.delete(data.receiverId);
				}
				return newMap;
			});
		};

		RTCEventEmitter.on("call-state-change", handleCallStateChange);

		return () => {
			RTCEventEmitter.removeAllListeners("call-state-change");
		};
	}, [])
	
	// Show max 5 avatars, collapse extras into "+N" avatar
	const maxVisible = 5
	const visiblePlayers = useMemo(() => players.slice(0, maxVisible), [players])
	const extraCount = useMemo(() => Math.max(0, players.length - maxVisible), [players])

// Call button intentionally does nothing for now
const onCall = useCallback((id:string) => {
	sendCallNotification(id);
}, [])

const handleAcceptCall = useCallback(async() => {
	setIsCallNotification(false);
	const newStream =await navigator.mediaDevices.getUserMedia({video:true,audio:true});
	setMyStream(newStream);
	await setCurrentStateStream(newStream);
	// Empty handler as requested
}, [])
const handleLeaveCall= useCallback(async ()=>{
	broadcastCallLeave();
	setCallerStream(null);
	const previousCallerId = callerInfo?.id;
	setCallerInfo(null);
	setCurrentStateInfo(null)
	// Stop user's own stream tracks if they exist
	if (myStream) {
		myStream.getTracks().forEach(track => track.stop());
		setMyStream(null);
	}
	// Clear call state from activeCalls
	if (previousCallerId && selfId) {
		setActiveCalls((prev) => {
			const newMap = new Map(prev);
			newMap.delete(selfId);
			newMap.delete(previousCallerId);
			return newMap;
		});
	}
},[callerInfo, selfId, myStream])
const handleRejectCall = useCallback(() => {
	setIsCallNotification(false);
	setCurrentStateInfo(null)
	setCallerInfo(null);
	setCallerStream(null)
}, [])

	// Don't render when whiteboard is open
	if (isWhiteboardOpen) {
		return null
	}

	return (
		<>
		{/* Draggable Video for Caller Stream */}
		{callerStream && (
			<DraggableVideo stream={callerStream} onLeaveCall={handleLeaveCall} />
		)}
		
		{/* Call Notification */}
		{isCallNotification && callerInfo && (
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
						You have been called by {callerInfo.name}
					</p>
					<div style={{
						display:"flex",
						gap:"0.75rem",
						justifyContent:"flex-end"
					}}>
						<button
							onClick={handleRejectCall}
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
							onClick={()=>{handleAcceptCall()}}
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
		<button
		onClick={() => setIsOpen(o => !o)}
		className={`fixed right-0 top-1/2 -translate-y-1/2 z-[60]
		w-8 h-16 flex items-center justify-center
		rounded-l-xl rounded-r-none
		bg-white/10 backdrop-blur-md shadow-xl
		hover:bg-white/20
		border border-white/20 border-r-0
		transition-all duration-400 ease-[cubic-bezier(0.34,1.56,0.64,1)]
		${isOpen ? 'right-[376px]' : 'right-0'}`}
		>
		{isOpen ? <ChevronRight className="w-5 h-5" /> : <ChevronLeft className="w-5 h-5" />}
		</button>
		<div
			className={`absolute top-1/2 right-4 -translate-y-1/2 z-60 transition-transform duration-300
			${isOpen ? 'translate-x-0' : 'translate-x-[calc(100%+1rem)] pointer-events-none'}`}
		>
			<div className="relative w-[360px] max-w-[80vw]">
				{/* Glass crystal background container */}
				<div className="absolute inset-0 bg-white/10 backdrop-blur-md rounded-2xl shadow-xl border border-white/20" />

				{/* Panel container */}
				<div className={`relative overflow-hidden h-[50vh] opacity-100`}>
					<div className="flex flex-col p-3">
						{/* Removed top mini-avatars preview for simpler UI */}
						<div className="hidden">
							{visiblePlayers.map((p) => {
								const isCurrentUser = p.id === selfId
								// Get name from members list if available, otherwise fallback to p.name or p.id
								const member = members.find(m => m.id === p.id);
								const displayName = member?.name || p.name || p.id
								return (
									<TooltipProvider key={p.id}>
										<Tooltip>
											<TooltipTrigger asChild>
												<div className="relative flex-shrink-0">
													{isCurrentUser && (
														<div className="absolute -inset-1 bg-gradient-to-r from-blue-400 via-purple-500 to-pink-500 rounded-full opacity-60 blur-sm" />
													)}
													<Avatar className="h-10 w-10 cursor-pointer transition-all duration-200 hover:scale-110 hover:shadow-lg hover:shadow-blue-500/25 relative z-10">
														<AvatarImage src={p.avatar || (isCurrentUser ? user?.imageUrl : undefined)} alt={displayName} className="object-cover" />
														<AvatarFallback className="text-sm font-semibold bg-gradient-to-br from-slate-100 to-slate-200 text-slate-700 border border-slate-300/50">
															{isCurrentUser ? (user?.fullName?.split(' ').map(word => word[0]).join('') || 'U') : displayName.charAt(0).toUpperCase()}
														</AvatarFallback>
													</Avatar>
												</div>
											</TooltipTrigger>
											<TooltipContent side="bottom" className="bg-slate-900/95 backdrop-blur-sm border border-slate-700/50 text-white px-3 py-2 rounded-lg shadow-xl">
												<div className="text-center">
													<p className="font-medium text-sm">{displayName}</p>
													{isCurrentUser && (<p className="text-xs text-slate-400 mt-1">You</p>)}
												</div>
											</TooltipContent>
										</Tooltip>
									</TooltipProvider>
								)
							})}

							{/* "+N" avatar for extra participants */}
							{extraCount > 0 && (
								<TooltipProvider>
									<Tooltip>
										<TooltipTrigger asChild>
											<Avatar className="h-10 w-10 cursor-pointer transition-all duration-200 hover:scale-110 hover:shadow-lg hover:shadow-purple-500/25 flex-shrink-0">
												<AvatarFallback className="text-sm font-semibold bg-gradient-to-br from-purple-100 to-purple-200 text-purple-700 border border-purple-300/50">+{extraCount}</AvatarFallback>
											</Avatar>
										</TooltipTrigger>
										<TooltipContent side="bottom" className="bg-slate-900/95 backdrop-blur-sm border border-slate-700/50 text-white px-3 py-2 rounded-lg shadow-xl">
											<p className="font-medium text-sm">{extraCount} more participant{extraCount > 1 ? 's' : ''}</p>
										</TooltipContent>
									</Tooltip>
								</TooltipProvider>
							)}
						</div>

						{/* Tabs */}
						<div className="mt-0 mb-2 grid grid-cols-2 gap-2">
							<button onClick={() => setActiveTab('participants')} className={`flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-md border text-xs font-medium transition ${activeTab === 'participants' ? 'bg-slate-100 border-slate-300 text-slate-800' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'}`}>
								<Users2 className="w-4 h-4" />
								<span className="text-sm font-medium">Participants</span>
							</button>
							<button onClick={() => setActiveTab('chat')} className={`relative flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-md border text-xs font-medium transition ${activeTab === 'chat' ? 'bg-slate-100 border-slate-300 text-slate-800' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'}`}>
								<MessageSquareText className="w-4 h-4" />
								<span className="text-sm font-medium">Chat</span>
								{unreadCount > 0 && (
									<span 
										className="ml-2 bg-primary text-primary-foreground text-[10px] font-bold rounded-full min-w-4 h-4 px-1 inline-flex items-center justify-center shadow-lg z-20"
									>
										{unreadCount > 99 ? '99+' : unreadCount}
									</span>
								)}
							</button>
						</div>

						{/* Content */}
						<div className="bg-white border border-slate-200 rounded-md overflow-hidden flex flex-col h-[calc(50vh-110px)] p-2">
							{/* Participants pane (kept mounted) */}
							<div className={`${activeTab === 'participants' ? 'flex' : 'hidden'} flex-col flex-1 overflow-y-auto divide-y divide-slate-200 px-1`}>
								{players.map((p) => {
									const isCurrentUser = p.id === selfId
									// Get name from members list if available, otherwise fallback to p.name or p.id
									const member = members.find(m => m.id === p.id);
									const displayName = member?.name || p.name || p.id
									// Check if this player is in a call
									const isInCall = activeCalls.has(p.id)
									// Check if current user is in a call (disable all call buttons if so)
									const isCurrentUserInCall = selfId ? activeCalls.has(selfId) : false
									return (
										<div key={p.id} className="flex items-center gap-3 px-3 py-2">
											<Avatar className="h-8 w-8">
												<AvatarImage src={p.avatar || (isCurrentUser ? user?.imageUrl : undefined)} alt={displayName} />
												<AvatarFallback className="text-xs font-medium">{displayName.charAt(0).toUpperCase()}</AvatarFallback>
											</Avatar>
											<div className="min-w-0 flex-1">
												<p className="text-sm text-slate-700 truncate">{displayName}{isCurrentUser ? ' (You)' : ''}</p>
											</div>
											<div>
												{isInCall ? (
													<div className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-semibold border shadow-sm border-green-400 text-green-700 bg-gradient-to-r from-green-50 to-green-100">
														<span>In Call</span>
													</div>
												) : (
													<button
														onClick={()=>{onCall(p.id)}}
														disabled={isCurrentUser || isCurrentUserInCall}
														className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-semibold border shadow-sm transition transform active:scale-[0.98] focus:outline-none focus:ring-2 focus:ring-offset-0 ${isCurrentUser || isCurrentUserInCall ? 'opacity-60 cursor-not-allowed border-slate-200 text-slate-400 bg-slate-50' : 'cursor-pointer border-violet-400 text-violet-900 bg-gradient-to-r from-violet-50 to-violet-100 hover:from-violet-100 hover:to-violet-200 hover:border-violet-500 shadow-violet-100/60 focus:ring-violet-300/40'}`}
													>
														<Video className="w-3.5 h-3.5" />
														<span>Call</span>
													</button>
												)}
											</div>
										</div>
									)
								})}
							</div>

							{/* Chat pane (kept mounted) */}
							<div className={`${activeTab === 'chat' ? 'flex' : 'hidden'} flex-1 overflow-hidden`}>
								<TextChat embedded title="Room Chat" variant="solid" className="h-full w-full" roomId={roomId} />
							</div>
						</div>
						{/* leave room and start meeting button*/}
						<div className="mt-2 mb-2 grid grid-cols-1 gap-2">
							<LeaveRoomButton roomId={roomId} onBeforeLeave={handleLeaveCall} />
						</div>
					</div>
				</div>

				{/* Custom scrollbar styles */}
				<style jsx>{`
					.scrollbar-hide {
						-ms-overflow-style: none;
						scrollbar-width: none;
					}
					.scrollbar-hide::-webkit-scrollbar {
						display: none;
					}
				`}</style>
			</div>
		</div>

		</>
	)
}