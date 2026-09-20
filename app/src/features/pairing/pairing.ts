import {onPairNeeded, onDowngraded, onIdentityChanged} from '@/engine/store';
import {openPairSheet} from './pairSheet';
import {openIdentityChangedSheet} from './identityChangedSheet';
import {toast} from '@/components/widgets';

const openFor = new Set<string>();

onPairNeeded(({user, host, onPaired}) => {
  const uh = `${user}@${host}`;
  if (openFor.has(uh)) return;
  openFor.add(uh);
  const el = openPairSheet({user, host, onPaired});
  const obs = new MutationObserver(() => {
    if (!document.body.contains(el)) {
      openFor.delete(uh);
      obs.disconnect();
    }
  });
  obs.observe(document.body, {childList: true});
});

onDowngraded((user, host) => {
  toast(
    `${user}@${host}: the encrypted connection could not be verified. ` +
      'Re-pair this engine to be safe.',
    6000
  );
});

const identityOpenFor = new Set<string>();
onIdentityChanged(({user, host, onTrust}) => {
  const uh = `${user}@${host}`;
  if (identityOpenFor.has(uh)) return;
  identityOpenFor.add(uh);
  const el = openIdentityChangedSheet({user, host, onTrust});
  const obs = new MutationObserver(() => {
    if (!document.body.contains(el)) {
      identityOpenFor.delete(uh);
      obs.disconnect();
    }
  });
  obs.observe(document.body, {childList: true});
});
