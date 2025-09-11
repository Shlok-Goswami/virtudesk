'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { endCall, getLocalVideoStream, getRemoteVideoStream, onCallEnd, onCallResponse, onIncomingCall, onRemoteVideo, respondToCall } from '@/game/realtime/PlayerRealtime'

export default function VideoCallModal() {
	const [incomingFrom, setIncomingFrom] = useState<string | null>(null)
	const [activeWith, setActiveWith] = useState<string | null>(null)
	const localRef = useRef<HTMLVideoElement>(null)
	const remoteRef = useRef<HTMLVideoElement>(null)

	// wire incoming call prompts
	useEffect(() => {
		const offReq = onIncomingCall((fromId) => {
			setIncomingFrom(fromId)
		})
		const offResp = onCallResponse((remoteId, accepted) => {
			if (accepted) {
				setActiveWith(remoteId)
			}
		})
		const offEnd = onCallEnd((_remoteId) => {
			setActiveWith(null)
		})
		return () => { offReq(); offResp(); offEnd(); }
	}, [])

	// attach streams when active and when remote video arrives
	useEffect(() => {
		if (!activeWith) return
		const attach = () => {
			const local = getLocalVideoStream()
			const remote = getRemoteVideoStream(activeWith)
			if (local && localRef.current) {
				localRef.current.srcObject = local
				localRef.current.play().catch(() => {})
			}
			if (remote && remoteRef.current) {
				remoteRef.current.srcObject = remote
				remoteRef.current.play().catch(() => {})
			}
		}
		attach()
		const off = onRemoteVideo((id) => { if (id === activeWith) attach() })
		// retry a few times to catch late local/remote streams on caller side
		let tries = 0
		const iv = setInterval(() => {
			tries += 1
			if (!activeWith) return
			attach()
			const localReady = !!localRef.current?.srcObject
			const remoteReady = !!remoteRef.current?.srcObject
			if (localReady && remoteReady) {
				clearInterval(iv)
			}
			if (tries > 10) clearInterval(iv)
		}, 300)
		return () => { off(); clearInterval(iv) }
	}, [activeWith])

	const accept = useCallback(async () => {
		if (!incomingFrom) return
		await respondToCall(incomingFrom, true)
		setActiveWith(incomingFrom)
		setIncomingFrom(null)
	}, [incomingFrom])

	const reject = useCallback(async () => {
		if (!incomingFrom) return
		await respondToCall(incomingFrom, false)
		setIncomingFrom(null)
	}, [incomingFrom])

	const closeActive = useCallback(async () => {
		if (!activeWith) return
		await endCall(activeWith)
		setActiveWith(null)
	}, [activeWith])

	return (
		<>
			<Dialog open={!!incomingFrom} onOpenChange={() => {}}>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>Incoming video call</DialogTitle>
					</DialogHeader>
					<div className="flex items-center justify-end gap-2">
						<Button onClick={reject} variant="secondary">Reject</Button>
						<Button onClick={accept} className="bg-indigo-600 hover:bg-indigo-700 text-white">Accept</Button>
					</div>
				</DialogContent>
			</Dialog>

			<Dialog open={!!activeWith} onOpenChange={() => {}}>
				<DialogContent className="sm:max-w-3xl">
					<DialogHeader>
						<DialogTitle>Video Call</DialogTitle>
					</DialogHeader>
					<div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
						<video ref={remoteRef} autoPlay playsInline className="w-full rounded bg-black aspect-video" />
						<video ref={localRef} autoPlay muted playsInline className="w-full rounded bg-black aspect-video" />
					</div>
					<div className="flex items-center justify-end gap-2">
						<Button onClick={closeActive} className="bg-red-500 hover:bg-red-600 text-white">End Call</Button>
					</div>
				</DialogContent>
			</Dialog>
		</>
	)
}


