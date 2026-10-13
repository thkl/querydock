import { ChangeDetectionStrategy, Component, effect, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { combineLatest } from 'rxjs';
import type { TableSnapshot } from '@querydock/contracts';
import { ConnectionApiService } from '../connections/connection-api.service';

@Component({
  selector: 'qd-table-schema',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  templateUrl: './table-schema.component.html',
  styleUrl: './table-schema.component.css',
})
export class TableSchemaComponent {
  private readonly route = inject(ActivatedRoute);
  private requestVersion = 0;

  readonly connections = inject(ConnectionApiService);
  readonly routeState = toSignal(
    combineLatest([this.route.paramMap, this.route.queryParamMap]),
    { initialValue: [this.route.snapshot.paramMap, this.route.snapshot.queryParamMap] as const },
  );
  readonly snapshot = signal<TableSnapshot | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  constructor() {
    effect(() => {
      const [params, query] = this.routeState();
      const connection = this.connections.activeConnection();
      const table = params.get('tableName');
      const schema = query.get('schema') ?? 'public';
      const version = ++this.requestVersion;

      this.snapshot.set(null);
      this.error.set(null);
      if (!connection || !table) {
        this.loading.set(false);
        return;
      }

      this.loading.set(true);
      void this.connections.inspectTable(connection.connectionId, schema, table)
        .then((snapshot) => {
          if (version === this.requestVersion) this.snapshot.set(snapshot);
        })
        .catch((error: unknown) => {
          if (version === this.requestVersion) {
            this.error.set(error instanceof Error ? error.message : 'Unable to load table structure.');
          }
        })
        .finally(() => {
          if (version === this.requestVersion) this.loading.set(false);
        });
    });
  }
}
