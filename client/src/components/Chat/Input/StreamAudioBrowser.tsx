import { useRef, useEffect } from 'react';
import { useRecoilValue } from 'recoil';
import { getLatestText } from '~/utils';
import store from '~/store';

export default function StreamAudioBrowser({ index = 0 }) {
  const voice = useRecoilValue(store.voice);
  const cloudBrowserVoices = useRecoilValue(store.cloudBrowserVoices);
  const isSubmitting = useRecoilValue(store.isSubmittingFamily(index));
  const latestMessage = useRecoilValue(store.latestMessageFamily(index));
  const lastSpokenId = useRef<string | null>(null);

  useEffect(() => {
    if (
      isSubmitting ||
      !latestMessage ||
      latestMessage.isCreatedByUser ||
      !latestMessage.messageId ||
      latestMessage.messageId.includes('_') ||
      latestMessage.messageId === lastSpokenId.current
    ) {
      return;
    }

    const text = getLatestText(latestMessage);
    if (!text) return;

    const synth = window.speechSynthesis;
    if (!synth) return;

    lastSpokenId.current = latestMessage.messageId;

    const speak = () => {
      const availableVoices = synth.getVoices();
      const selectedVoice = voice
        ? availableVoices.find((v) => v.name === voice)
        : availableVoices.find((v) => cloudBrowserVoices || v.localService);

      synth.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      if (selectedVoice) {
        utterance.voice = selectedVoice;
      }
      synth.speak(utterance);
    };

    if (synth.getVoices().length) {
      speak();
    } else {
      synth.onvoiceschanged = () => {
        speak();
        synth.onvoiceschanged = null;
      };
    }
  }, [latestMessage, isSubmitting, voice, cloudBrowserVoices]);

  return null;
}
