import {installPipelineUiBindings} from './pipelineUiBindings';
import {installVoiceSettlement} from './voiceSettlement';
import {installVaultRecovery} from './vaultRecovery';
import type {VoiceCaptureDeps} from './captureState';

export {createCaptureState, type CaptureState, type VoiceDraft} from './captureState';

export function installVoiceCapture(deps: VoiceCaptureDeps): void {
  installPipelineUiBindings(deps);
  installVoiceSettlement(deps);
  installVaultRecovery(deps);
}
