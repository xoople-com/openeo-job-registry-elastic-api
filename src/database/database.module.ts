import { Module, OnApplicationShutdown, Inject } from '@nestjs/common';
import { Client, ClientOptions } from '@elastic/elasticsearch';
import { readFileSync } from 'fs';
import { ConfigModule } from '../config/config.module';
import { ConfigService } from '../config/config/config.service';
import { AuthType } from '../auth/models/authtypes.enum';

export function buildDatabaseOptions(config: ConfigService): ClientOptions {
  const nodes: string[] = config
    .get('database.hosts')
    .split(',')
    .map((host: string) => host.trim());
  const apiKey: string = config.get('database.apiKey');
  if (config.get('auth.type') === AuthType.ENTRA && !apiKey) {
    throw new Error('DB_API_KEY is required in entra mode');
  }
  for (const node of nodes) {
    let url: URL;
    try {
      url = new URL(node);
    } catch {
      throw new Error('DB_HOSTS contains an invalid URL');
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    ) {
      throw new Error(
        'DB_HOSTS must contain HTTP(S) origins without credentials',
      );
    }
    if (apiKey && url.protocol !== 'https:') {
      throw new Error('DB_API_KEY requires HTTPS for every DB_HOSTS endpoint');
    }
  }
  const caFile: string = config.get('database.caFile');
  return {
    nodes,
    ...(apiKey ? { auth: { apiKey } } : {}),
    tls: {
      rejectUnauthorized: true,
      ...(caFile ? { ca: readFileSync(caFile) } : {}),
    },
  };
}

@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: Client,
      useFactory: (config: ConfigService) =>
        new Client(buildDatabaseOptions(config)),
      inject: [ConfigService],
    },
  ],
  exports: [Client],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(Client) private readonly client: Client) {}

  async onApplicationShutdown() {
    await this.client.close();
  }
}
