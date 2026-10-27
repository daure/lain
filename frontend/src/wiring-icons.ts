import amazonwebservices from './assets/wiring-icons/devicon/amazonwebservices.svg?inline';
import azure from './assets/wiring-icons/devicon/azure.svg?inline';
import googlecloud from './assets/wiring-icons/devicon/googlecloud.svg?inline';
import angular from './assets/wiring-icons/devicon/angular.svg?inline';
import spring from './assets/wiring-icons/devicon/spring.svg?inline';
import postgresql from './assets/wiring-icons/devicon/postgresql.svg?inline';
import redis from './assets/wiring-icons/devicon/redis.svg?inline';
import apachekafka from './assets/wiring-icons/devicon/apachekafka.svg?inline';
import datadog from './assets/wiring-icons/devicon/datadog.svg?inline';
import sentry from './assets/wiring-icons/devicon/sentry.svg?inline';
import browser from './assets/wiring-icons/tabler/browser.svg?inline';
import server from './assets/wiring-icons/tabler/server.svg?inline';
import database from './assets/wiring-icons/tabler/database.svg?inline';
import list from './assets/wiring-icons/tabler/list.svg?inline';
import broadcast from './assets/wiring-icons/tabler/broadcast.svg?inline';
import bucket from './assets/wiring-icons/tabler/bucket.svg?inline';
import router from './assets/wiring-icons/tabler/router.svg?inline';
import shieldLock from './assets/wiring-icons/tabler/shield-lock.svg?inline';
import cpu from './assets/wiring-icons/tabler/cpu.svg?inline';
import cube from './assets/wiring-icons/tabler/cube.svg?inline';
import cloud from './assets/wiring-icons/tabler/cloud.svg?inline';

type WiringIcon = { url: string; label: string };

const icons = new Map<string, WiringIcon>([
  ['amazonwebservices', { url: amazonwebservices, label: 'AWS' }],
  ['azure', { url: azure, label: 'Azure' }],
  ['googlecloud', { url: googlecloud, label: 'Google Cloud' }],
  ['angular', { url: angular, label: 'Angular' }],
  ['spring', { url: spring, label: 'Spring' }],
  ['postgresql', { url: postgresql, label: 'PostgreSQL' }],
  ['redis', { url: redis, label: 'Redis' }],
  ['apachekafka', { url: apachekafka, label: 'Apache Kafka' }],
  ['datadog', { url: datadog, label: 'Datadog' }],
  ['sentry', { url: sentry, label: 'Sentry' }],
  ['browser', { url: browser, label: 'Browser' }],
  ['server', { url: server, label: 'Service' }],
  ['database', { url: database, label: 'Database' }],
  ['queue', { url: list, label: 'Queue' }],
  ['topic', { url: broadcast, label: 'Topic' }],
  ['stream', { url: broadcast, label: 'Stream' }],
  ['eventbus', { url: broadcast, label: 'Event bus' }],
  ['bucket', { url: bucket, label: 'Object storage' }],
  ['cache', { url: database, label: 'Cache' }],
  ['gateway', { url: router, label: 'Gateway' }],
  ['identity', { url: shieldLock, label: 'Identity provider' }],
  ['observability', { url: broadcast, label: 'Observability' }],
  ['worker', { url: cpu, label: 'Worker' }],
  ['function', { url: cpu, label: 'Function' }],
  ['externalsystem', { url: cloud, label: 'External system' }],
  ['other', { url: cube, label: 'Component' }],
]);

const kindAliases = new Map([
  ['uiapp', 'browser'],
  ['uicomponent', 'browser'],
  ['service', 'server'],
  ['browser', 'browser'],
  ['server', 'server'],
  ['database', 'database'],
  ['queue', 'queue'],
  ['topic', 'topic'],
  ['stream', 'stream'],
  ['eventbus', 'eventbus'],
  ['bucket', 'bucket'],
  ['cache', 'cache'],
  ['gateway', 'gateway'],
  ['identity', 'identity'],
  ['observability', 'observability'],
  ['worker', 'worker'],
  ['function', 'function'],
  ['externalsystem', 'externalsystem'],
  ['other', 'other'],
]);

const productAliases = new Map([
  ['angular', 'angular'],
  ['spring', 'spring'],
  ['springframework', 'spring'],
  ['springboot', 'spring'],
  ['postgres', 'postgresql'],
  ['postgresql', 'postgresql'],
  ['pg', 'postgresql'],
  ['redis', 'redis'],
  ['kafka', 'apachekafka'],
  ['apachekafka', 'apachekafka'],
  ['datadog', 'datadog'],
  ['sentry', 'sentry'],
  ['sentryio', 'sentry'],
]);

const providerAliases = new Map([
  ['aws', 'amazonwebservices'],
  ['amazonaws', 'amazonwebservices'],
  ['amazonwebservices', 'amazonwebservices'],
  ['azure', 'azure'],
  ['microsoftazure', 'azure'],
  ['gcp', 'googlecloud'],
  ['googlecloud', 'googlecloud'],
  ['googlecloudplatform', 'googlecloud'],
]);

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function wiringIcon(
  technology: { name: string; provider?: string; icon?: string } | undefined,
  kind: string,
): { url: string; label: string } {
  const kindId = normalize(kind);
  const fallback = icons.get(kindAliases.get(kindId) ?? 'other')!;
  if (technology?.icon !== undefined) {
    const iconId = normalize(technology.icon);
    return icons.get(kindAliases.get(iconId) ?? iconId) ?? fallback;
  }
  const name = normalize(technology?.name ?? '');
  const id = productAliases.get(name) ?? providerAliases.get(name)
    ?? providerAliases.get(normalize(technology?.provider ?? ''));
  return (id ? icons.get(id) : undefined) ?? fallback;
}
