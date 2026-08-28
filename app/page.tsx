import { ModelRoomPreview } from '@/components/model-room-preview';
import { StudioProvider } from '@/components/studio-provider';

export default function Home() {
  return <StudioProvider><ModelRoomPreview /></StudioProvider>;
}
