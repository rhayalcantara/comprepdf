from app.config import settings

broker_url = settings.REDIS_URL
result_backend = settings.REDIS_URL

task_serializer = 'json'
result_serializer = 'json'
accept_content = ['json']
timezone = 'UTC'
enable_utc = True

task_acks_late = True
task_reject_on_worker_lost = True
worker_prefetch_multiplier = 1
