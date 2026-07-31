<?php

declare(strict_types=1);

namespace App\Http\Middleware;

use Illuminate\Http\Request;
use Inertia\Middleware;

/**
 * Shared props for every back-office page (spec 03 §2.1).
 */
final class HandleInertiaRequests extends Middleware
{
    protected $rootView = 'app';

    /**
     * @return array<string, mixed>
     */
    public function share(Request $request): array
    {
        return [
            ...parent::share($request),
            'auth' => fn (): ?array => $request->user() === null ? null : [
                'user' => [
                    'id' => $request->user()->getKey(),
                    'name' => $request->user()->getAttribute('name'),
                    'email' => $request->user()->getAttribute('email'),
                ],
                'abilities' => $this->abilities($request),
            ],
            'flash' => fn (): array => [
                'success' => $request->session()->get('success'),
                'error' => $request->session()->get('error'),
            ],
        ];
    }

    /** @return list<string> */
    private function abilities(Request $request): array
    {
        $user = $request->user();

        if ($user === null) {
            return [];
        }

        if (method_exists($user, 'abilities')) {
            /** @var list<string> $abilities */
            $abilities = $user->abilities();

            return $abilities;
        }

        return ['backoffice.access'];
    }
}
